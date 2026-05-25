import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { argv, cwd } from 'node:process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { ZipArchive } from './zip-archive.mjs'

const root = cwd()
const outDir = join(root, 'release')
const zipPath = join(outDir, argv[2] ?? 'textum-extension.zip')

await mkdir(outDir, { recursive: true })
await rm(zipPath, { force: true })

const archive = new ZipArchive()
await archive.addDirectory(join(root, 'dist'), '')

const output = createWriteStream(zipPath)
await finished(Readable.from(archive.toBuffer()).pipe(output))

console.log(`Packaged ${basename(zipPath)} from dist/`)
