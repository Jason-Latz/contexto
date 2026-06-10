from __future__ import annotations

import hashlib
import tarfile
import urllib.request
from dataclasses import dataclass
from html import unescape
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree

from .models import RawFreeDictEntry


FREEDICT_SOURCE_ID = "freedict-eng-spa-2025.11.23"
FREEDICT_URL = (
    "https://download.freedict.org/dictionaries/eng-spa/2025.11.23/"
    "freedict-eng-spa-2025.11.23.src.tar.xz"
)
FREEDICT_VERSION = "2025.11.23"
FREEDICT_LICENSE = "Creative Commons Attribution-ShareAlike 3.0 Unported"
FREEDICT_TEI_MEMBER = "eng-spa/eng-spa.tei"
TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


@dataclass(frozen=True)
class DownloadedSource:
    archive_path: Path
    sha256: str
    byte_count: int


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_freedict(cache_dir: Path, *, force: bool = False) -> DownloadedSource:
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path = cache_dir / "freedict-eng-spa-2025.11.23.src.tar.xz"

    if force or not archive_path.exists():
        with urllib.request.urlopen(FREEDICT_URL, timeout=60) as response:
            archive_path.write_bytes(response.read())

    return DownloadedSource(
        archive_path=archive_path,
        sha256=sha256_file(archive_path),
        byte_count=archive_path.stat().st_size,
    )


def extract_tei(archive_path: Path, cache_dir: Path) -> Path:
    output_dir = cache_dir / "freedict-eng-spa-2025.11.23"
    tei_path = output_dir / FREEDICT_TEI_MEMBER

    if tei_path.exists():
        return tei_path

    output_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, mode="r:xz") as archive:
        archive.extractall(output_dir)

    if not tei_path.exists():
        raise FileNotFoundError(f"Expected TEI file not found: {tei_path}")
    return tei_path


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(unescape(value.replace("\xa0", " ")).split())


def element_text(element: ElementTree.Element) -> str:
    return clean_text("".join(element.itertext()))


def parse_freedict_tei(tei_path: Path) -> list[RawFreeDictEntry]:
    root = ElementTree.parse(tei_path).getroot()
    entries: list[RawFreeDictEntry] = []

    for index, entry in enumerate(root.findall(".//tei:entry", TEI_NS)):
        source = clean_text(entry.findtext("./tei:form/tei:orth", namespaces=TEI_NS))
        raw_pos = clean_text(entry.findtext("./tei:gramGrp/tei:pos", namespaces=TEI_NS))
        translations = tuple(
            text
            for quote in entry.findall('.//tei:cit[@type="trans"]/tei:quote', TEI_NS)
            if (text := element_text(quote))
        )
        definitions = tuple(
            text
            for definition in entry.findall(".//tei:def", TEI_NS)
            if (text := element_text(definition))
        )

        if source and raw_pos and translations:
            entries.append(
                RawFreeDictEntry(
                    source=source,
                    raw_pos=raw_pos,
                    translations=translations,
                    definitions=definitions,
                    source_order=index,
                )
            )

    return entries


def load_freedict_entries(cache_dir: Path, *, force_download: bool = False) -> tuple[DownloadedSource, list[RawFreeDictEntry]]:
    downloaded = download_freedict(cache_dir, force=force_download)
    tei_path = extract_tei(downloaded.archive_path, cache_dir)
    return downloaded, parse_freedict_tei(tei_path)


def iter_source_license_lines(archive_path: Path) -> Iterable[str]:
    with tarfile.open(archive_path, mode="r:xz") as archive:
        copying = archive.extractfile("eng-spa/COPYING")
        if copying is None:
            return
        for raw in copying.read().decode("utf-8", errors="replace").splitlines():
            yield raw

