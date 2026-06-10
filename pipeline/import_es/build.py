from __future__ import annotations

import argparse
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .enrich import load_optional_enrichment
from .freedict import (
    FREEDICT_LICENSE,
    FREEDICT_SOURCE_ID,
    FREEDICT_URL,
    FREEDICT_VERSION,
    load_freedict_entries,
)
from .models import ImportCandidate
from .normalize import normalize_entries


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_ROOT = PROJECT_ROOT / "pipeline"
DEFAULT_PACK = PROJECT_ROOT / "public" / "language-packs" / "es.json"
DEFAULT_CACHE = PIPELINE_ROOT / "data" / "import-cache" / "es"
DEFAULT_GENERATED = PROJECT_ROOT / "imports" / "language-packs" / "es" / "generated" / "freedict-kaikki-omw.json"
DEFAULT_LOCK = PIPELINE_ROOT / "sources" / "es.lock.json"
CURATED_SOURCE_ID = "curated-contexto"
SIZE_WARNING_GZIP_BYTES = 10 * 1024 * 1024


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_curated_metadata(pack: dict[str, Any]) -> None:
    sources = pack.setdefault("sources", {})
    sources.setdefault(
        CURATED_SOURCE_ID,
        {
            "name": "Contexto curated Spanish language pack",
            "url": "https://github.com/Jason-Latz/contexto",
            "license": "MIT",
            "notes": "Entries manually curated or generated before the public import pipeline.",
        },
    )

    for entry in pack["entries"].values():
        entry.setdefault("sourceIds", [CURATED_SOURCE_ID])


def strip_previous_generated_entries(pack: dict[str, Any]) -> dict[str, Any]:
    entries = {}
    for key, entry in pack["entries"].items():
        source_ids = set(entry.get("sourceIds", []))
        is_generated_import = FREEDICT_SOURCE_ID in source_ids and CURATED_SOURCE_ID not in source_ids
        if not is_generated_import:
            entries[key] = entry

    return {**pack, "entries": entries}


def max_rank(entries: dict[str, dict[str, Any]]) -> int:
    return max((int(entry["frequencyRank"]) for entry in entries.values()), default=0)


def selected_generated_entries(
    candidates: list[ImportCandidate],
    existing_entries: dict[str, dict[str, Any]],
    target_count: int,
) -> list[ImportCandidate]:
    needed = target_count - len(existing_entries)
    if needed <= 0:
        return []

    existing_keys = set(existing_entries)
    selected: list[ImportCandidate] = []
    for candidate in candidates:
        if candidate.source in existing_keys:
            continue
        selected.append(candidate)
        if len(selected) == needed:
            break

    if len(selected) < needed:
        raise RuntimeError(
            f"Only {len(selected)} generated entries passed filters; {needed} required "
            f"to reach {target_count} total entries."
        )
    return selected


def merge_pack(
    pack: dict[str, Any],
    selected: list[ImportCandidate],
    downloaded_sha256: str,
    fetched_at: str,
) -> dict[str, Any]:
    output = {
        **pack,
        "version": fetched_at[:10],
        "sources": {
            **pack["sources"],
            FREEDICT_SOURCE_ID: {
                "name": "FreeDict English-Spanish",
                "url": FREEDICT_URL,
                "license": FREEDICT_LICENSE,
                "version": FREEDICT_VERSION,
                "fetchedAt": fetched_at,
                "notes": f"SHA-256: {downloaded_sha256}",
            },
            "kaikki-en": {
                "name": "Kaikki English Wiktionary extraction",
                "url": "https://kaikki.org/dictionary/rawdata.html",
                "license": "CC-BY-SA and GFDL",
                "notes": "Optional local enrichment source; not required for this generated pack.",
            },
            "kaikki-es": {
                "name": "Kaikki Spanish Wiktionary extraction",
                "url": "https://kaikki.org/dictionary/Spanish/index.html",
                "license": "CC-BY-SA and GFDL",
                "notes": "Optional local enrichment source; not required for this generated pack.",
            },
            "omw": {
                "name": "Open Multilingual Wordnet",
                "url": "https://omwn.org/",
                "license": "Mixed open licenses by component wordnet",
                "notes": "Optional corroboration source; not required for this generated pack.",
            },
            "apertium-eng-spa": {
                "name": "Apertium English-Spanish",
                "url": "https://github.com/apertium/apertium-eng-spa",
                "license": "GPL-2.0",
                "notes": "Optional corroboration source; not required for this generated pack.",
            },
        },
        "entries": dict(pack["entries"]),
    }

    next_rank = max_rank(output["entries"]) + 1
    for candidate in selected:
        output["entries"][candidate.source] = candidate.to_entry(next_rank)
        next_rank += 1

    return output


def pack_size_report(pack: dict[str, Any]) -> dict[str, int | bool]:
    raw = (json.dumps(pack, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    gzip_size = len(gzip.compress(raw))
    return {
        "rawBytes": len(raw),
        "gzipBytes": gzip_size,
        "gzipWarning": gzip_size > SIZE_WARNING_GZIP_BYTES,
    }


def build(args: argparse.Namespace) -> None:
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    pack = read_json(args.pack)
    ensure_curated_metadata(pack)
    curated_pack = strip_previous_generated_entries(pack)

    downloaded, raw_entries = load_freedict_entries(args.cache_dir, force_download=args.force_download)
    enrichment = load_optional_enrichment(args.cache_dir)
    candidates = normalize_entries(raw_entries, enrichment)
    selected = selected_generated_entries(candidates, curated_pack["entries"], args.target_count)

    generated_fragment = {
        "entries": {
            candidate.source: candidate.to_entry(index + 1)
            for index, candidate in enumerate(selected)
        }
    }
    write_json(args.generated, generated_fragment)

    output = merge_pack(curated_pack, selected, downloaded.sha256, fetched_at)
    write_json(args.pack, output)

    source_counts: dict[str, int] = {}
    for entry in output["entries"].values():
        for source_id in entry.get("sourceIds", []):
            source_counts[source_id] = source_counts.get(source_id, 0) + 1

    size_report = pack_size_report(output)
    lock = {
        "targetLanguage": "es",
        "targetCount": args.target_count,
        "generatedAt": fetched_at,
        "sources": {
            FREEDICT_SOURCE_ID: {
                "url": FREEDICT_URL,
                "version": FREEDICT_VERSION,
                "license": FREEDICT_LICENSE,
                "sha256": downloaded.sha256,
                "bytes": downloaded.byte_count,
                "rawEntries": len(raw_entries),
                "acceptedCandidates": len(candidates),
                "mergedEntries": len(selected),
            },
            "kaikki-en": {
                "url": "https://kaikki.org/dictionary/rawdata.html",
                "license": "CC-BY-SA and GFDL",
                "used": "kaikki-en" in enrichment.source_ids,
            },
            "kaikki-es": {
                "url": "https://kaikki.org/dictionary/Spanish/index.html",
                "license": "CC-BY-SA and GFDL",
                "used": "kaikki-es" in enrichment.source_ids,
            },
            "omw": {
                "url": "https://omwn.org/",
                "license": "Mixed open licenses by component wordnet",
                "used": "omw" in enrichment.source_ids,
            },
            "apertium-eng-spa": {
                "url": "https://github.com/apertium/apertium-eng-spa",
                "license": "GPL-2.0",
                "used": "apertium-eng-spa" in enrichment.source_ids,
            },
        },
        "counts": {
            "existingCuratedEntries": len(curated_pack["entries"]),
            "finalEntries": len(output["entries"]),
            "sourceIdUsage": source_counts,
        },
        "size": size_report,
    }
    write_json(args.lock, lock)

    print(json.dumps({
        "rawEntries": len(raw_entries),
        "acceptedCandidates": len(candidates),
        "mergedEntries": len(selected),
        "finalEntries": len(output["entries"]),
        **size_report,
    }, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Contexto Spanish language pack imports.")
    parser.add_argument("--target-count", type=int, default=50_000)
    parser.add_argument("--pack", type=Path, default=DEFAULT_PACK)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--generated", type=Path, default=DEFAULT_GENERATED)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--force-download", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
