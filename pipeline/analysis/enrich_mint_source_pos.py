#!/usr/bin/env python3
"""Add the English source-POS contract to frozen mint queue files.

The Wave 2 ordered queues are already the immutable batch map for persisted raw
adjudications, so rebuilding them would reorder or omit work. This utility only
enriches existing rows in place: key order, row count, alternatives, and every
non-POS field remain unchanged. It updates both the canonical and ordered queue
copies and keeps a hard-linked ``.pre-source-pos`` backup of each original.

Dry-run is the default. Use ``--write`` only before a factory manifest is
initialized; the runner deliberately treats any later queue hash change as
fatal drift.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
from collections import Counter
from pathlib import Path

from pipeline.analysis import build_mint_queue as bmq

LANGUAGES = ("de", "fr", "it", "es")
BACKUP_SUFFIX = ".pre-source-pos"


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number}: row is not an object")
            rows.append(row)
    return rows


def ordered_key_digest(rows: list[dict]) -> str:
    keys = [row.get("key") for row in rows]
    if any(not isinstance(key, str) or not key for key in keys):
        raise ValueError("queue row lacks a non-empty string key")
    if len(keys) != len(set(keys)):
        raise ValueError("queue contains duplicate keys")
    return hashlib.sha256("\n".join(keys).encode("utf-8")).hexdigest()


def enrich_rows(lang: str, rows: list[dict], indexes: dict) -> tuple[list[dict], dict]:
    """Return deep-copied rows with source-POS fields plus coverage statistics."""
    if lang not in LANGUAGES:
        raise ValueError(f"unsupported language {lang!r}")

    original_digest = ordered_key_digest(rows)
    enriched: list[dict] = []
    coverage: Counter[str] = Counter()

    for row_number, original in enumerate(rows, 1):
        row = copy.deepcopy(original)
        key = bmq.norm(row.get("key"))
        source = bmq.norm(row.get("source"))
        if not key or key != source:
            raise ValueError(
                f"{lang} row {row_number}: key/source mismatch "
                f"({row.get('key')!r} vs {row.get('source')!r})"
            )

        alternatives = row.get("alternatives")
        if not isinstance(alternatives, list) or not alternatives:
            raise ValueError(f"{lang}:{key}: missing alternatives")

        row_candidates, source_pos = bmq.build_source_pos_contract(key, indexes)
        row["sourcePosCandidates"] = row_candidates
        row["sourcePos"] = source_pos
        coverage[
            "row_none" if not row_candidates
            else "row_singleton" if len(row_candidates) == 1
            else "row_ambiguous"
        ] += 1

        seen_targets: set[str] = set()
        for alternative in alternatives:
            if not isinstance(alternative, dict):
                raise ValueError(f"{lang}:{key}: alternative is not an object")
            target = alternative.get("target")
            target_key = bmq.norm(target)
            if not target_key:
                raise ValueError(f"{lang}:{key}: alternative lacks a target")
            if target_key in seen_targets:
                raise ValueError(f"{lang}:{key}: duplicate normalized target {target!r}")
            seen_targets.add(target_key)

            pair_candidates = bmq.build_alternative_source_pos_contract(
                lang, key, target, indexes
            )
            alternative["sourcePosCandidates"] = pair_candidates
            coverage["alternatives"] += 1
            if pair_candidates:
                coverage["alternative_pair_authorized"] += 1
            if len(pair_candidates) > 1:
                coverage["alternative_pair_ambiguous"] += 1

        if alternatives[0]["sourcePosCandidates"]:
            coverage["top_alternative_pair_authorized"] += 1
        enriched.append(row)

    if ordered_key_digest(enriched) != original_digest:
        raise AssertionError(f"{lang}: enrichment changed the ordered key mapping")

    return enriched, dict(sorted(coverage.items()))


def queue_paths(repo_root: Path, lang: str) -> tuple[Path, Path]:
    queue_dir = repo_root / "pipeline" / "data" / "queues"
    return (
        queue_dir / f"mint-{lang}.jsonl",
        queue_dir / f"mint-{lang}.ordered.jsonl",
    )


def write_jsonl_with_backup(path: Path, rows: list[dict]) -> None:
    """Atomically replace one queue while preserving its first pre-change inode."""
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup.exists():
        try:
            os.link(path, backup)
        except OSError:
            shutil.copy2(path, backup)

    temp = path.with_name(path.name + ".source-pos.tmp")
    if temp.exists():
        raise FileExistsError(f"stale temp file blocks write: {temp}")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def build_indexes(
    lang: str, entr_index: dict, ensense_index: dict, wordnet_index: dict
) -> dict:
    return {
        "freedict": bmq.load_freedict_index(lang),
        "apertium": bmq.load_apertium_index(lang),
        "omw": bmq.load_omw_index(lang),
        "entr": entr_index,
        "ensense": ensense_index,
        "wordnet_pos": wordnet_index,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--language", action="append", choices=LANGUAGES,
                        help="language to enrich; repeatable (default: all four)")
    parser.add_argument("--write", action="store_true",
                        help="atomically replace queues after a complete dry preflight")
    args = parser.parse_args(argv)

    languages = tuple(dict.fromkeys(args.language or LANGUAGES))
    all_rows: dict[str, tuple[list[dict], list[dict]]] = {}
    words: set[str] = set()
    for lang in languages:
        canonical_path, ordered_path = queue_paths(bmq.REPO_ROOT, lang)
        canonical = load_jsonl(canonical_path)
        ordered = load_jsonl(ordered_path)
        canonical_keys = {row.get("key") for row in canonical}
        missing = [row.get("key") for row in ordered if row.get("key") not in canonical_keys]
        if missing:
            raise ValueError(f"{lang}: ordered queue has {len(missing)} keys absent from canonical")
        all_rows[lang] = (canonical, ordered)
        words.update(row.get("source", "") for row in canonical)

    entr_index = bmq.load_entr_index()
    ensense_index = bmq.load_ensense_index()
    wordnet_index = bmq.load_wordnet_pos_index(words)

    staged: dict[str, tuple[list[dict], list[dict]]] = {}
    report = {"ok": True, "write": args.write, "languages": {}}
    for lang in languages:
        canonical, ordered = all_rows[lang]
        indexes = build_indexes(lang, entr_index, ensense_index, wordnet_index)
        enriched_canonical, canonical_stats = enrich_rows(lang, canonical, indexes)
        enriched_ordered, ordered_stats = enrich_rows(lang, ordered, indexes)
        staged[lang] = (enriched_canonical, enriched_ordered)
        report["languages"][lang] = {
            "canonicalRows": len(canonical),
            "orderedRows": len(ordered),
            "canonicalKeyDigest": ordered_key_digest(canonical),
            "orderedKeyDigest": ordered_key_digest(ordered),
            "canonicalCoverage": canonical_stats,
            "orderedCoverage": ordered_stats,
        }

    if args.write:
        for lang in languages:
            canonical_path, ordered_path = queue_paths(bmq.REPO_ROOT, lang)
            enriched_canonical, enriched_ordered = staged[lang]
            write_jsonl_with_backup(canonical_path, enriched_canonical)
            write_jsonl_with_backup(ordered_path, enriched_ordered)

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
