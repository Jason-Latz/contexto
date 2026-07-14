"""Remove the legacy curated synthetic-compound entries from the Spanish pack.

The pre-pipeline Spanish seed generation invented combinatorial multi-word
headwords ("team report", "kitchen photo") that no dictionary lists. They are
UNREACHABLE at runtime — the unigram pass matches single words and the
expression scanner only indexes partOfSpeech == "expression" — so they teach
nothing while wasting pack size, first-run prepopulation slots, and rank space.
The modern importer cannot produce them (normalize_entry converts multi-word
sources to "expression"), so removing them from the pack is durable: build.py
treats the shipped pack as the source of truth for curated entries.

No backfill, deliberately. FreeDict is exhausted past the already-imported
45,795 entries: what remains is the junk band the pipeline's own tests pin out
of the pack ('to', 'apian', marker targets). The pack count honestly lands
where the real data ends; growth is the job of the gold-gated minting engine
(pipeline/analysis), not a bulk import.

Run:  python3 -m pipeline.import_es.remove_legacy_compounds
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .build import CURATED_SOURCE_ID, DEFAULT_PACK, read_json, write_json

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_FIXTURE = PROJECT_ROOT / "tests" / "fixtures" / "golden-es.json"
REMOVAL_RECORD = PROJECT_ROOT / "docs" / "data-maintenance" / "2026-07-14-removed-legacy-compounds.jsonl"
GOLDEN_MIN = 150


def is_legacy_compound(source: str, entry: dict) -> bool:
    return (
        " " in source
        and entry.get("partOfSpeech") != "expression"
        and entry.get("sourceIds") == [CURATED_SOURCE_ID]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, default=DEFAULT_PACK)
    parser.add_argument("--removal-record", type=Path, default=REMOVAL_RECORD)
    parser.add_argument("--golden-fixture", type=Path, default=GOLDEN_FIXTURE)
    args = parser.parse_args()

    # Running against a COPY of the pack must not clobber the real repo's
    # audit record or golden fixture (review finding) — refuse the implicit
    # side-effect paths when the pack path was overridden.
    if args.pack != DEFAULT_PACK and (args.removal_record == REMOVAL_RECORD
                                      or args.golden_fixture == GOLDEN_FIXTURE):
        raise SystemExit("--pack was overridden: pass --removal-record and "
                         "--golden-fixture explicitly too")

    pack = read_json(args.pack)
    entries = pack["entries"]

    removed = {key: entry for key, entry in entries.items() if is_legacy_compound(key, entry)}
    for key in removed:
        del entries[key]

    # Audit trail: one compact line per removed entry (the pack diff itself is
    # too large to review by eye).
    args.removal_record.parent.mkdir(parents=True, exist_ok=True)
    with args.removal_record.open("w", encoding="utf-8") as fh:
        for key, entry in sorted(removed.items()):
            fh.write(json.dumps({
                "source": key,
                "target": entry.get("target"),
                "partOfSpeech": entry.get("partOfSpeech"),
                "sourceGloss": entry.get("sourceGloss"),
                "frequencyRank": entry.get("frequencyRank"),
            }, ensure_ascii=False) + "\n")

    write_json(args.pack, pack)

    # The golden fixture snapshotted a handful of the legacy compounds; those
    # rows guarded junk, not verified pairs, and leave with the data.
    golden = json.loads(args.golden_fixture.read_text())
    kept_golden = [g for g in golden if g["source"].lower() not in removed]
    dropped_golden = [g["source"] for g in golden if g["source"].lower() in removed]
    if len(kept_golden) < GOLDEN_MIN:
        raise RuntimeError(f"golden fixture would shrink below {GOLDEN_MIN} ({len(kept_golden)})")
    args.golden_fixture.write_text(json.dumps(kept_golden, ensure_ascii=False, indent=2) + "\n")

    print(json.dumps({
        "removed": len(removed),
        "finalEntries": len(entries),
        "goldenDropped": dropped_golden,
        "removalRecord": str(args.removal_record),
    }, indent=2))


if __name__ == "__main__":
    main()
