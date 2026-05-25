import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const day =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  return { time, day }
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

export class ZipArchive {
  #files = []

  async addDirectory(root, prefix) {
    const entries = await readdir(root)
    for (const entry of entries) {
      const absolute = join(root, entry)
      const info = await stat(absolute)
      if (info.isDirectory()) {
        await this.addDirectory(absolute, posix.join(prefix, entry))
      } else if (info.isFile()) {
        const rel = relative(root, absolute).split(sep).join('/')
        await this.addFile(absolute, posix.join(prefix, rel), info.mtime)
      }
    }
  }

  async addFile(absolute, archivePath, modifiedAt) {
    this.#files.push({
      path: archivePath,
      data: await readFile(absolute),
      modifiedAt,
    })
  }

  toBuffer() {
    const localParts = []
    const centralParts = []
    let offset = 0

    for (const file of this.#files) {
      const name = Buffer.from(file.path, 'utf8')
      const checksum = crc32(file.data)
      const { time, day } = dosDateTime(file.modifiedAt)

      const localHeader = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
        u32(checksum), u32(file.data.length), u32(file.data.length),
        u16(name.length), u16(0), name,
      ])

      const centralHeader = Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
        u32(checksum), u32(file.data.length), u32(file.data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
      ])

      localParts.push(localHeader, file.data)
      centralParts.push(centralHeader)
      offset += localHeader.length + file.data.length
    }

    const central = Buffer.concat(centralParts)
    const end = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(this.#files.length), u16(this.#files.length),
      u32(central.length), u32(offset), u16(0),
    ])

    return Buffer.concat([...localParts, central, end])
  }
}
