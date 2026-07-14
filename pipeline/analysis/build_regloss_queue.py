#!/usr/bin/env python3
"""Build the regloss adjudication queue: suspect glosses + sourced candidates.

Rows feed the same gold-gated adjudicate -> refute -> apply flow as audits and
mints, but for DEFINITIONS instead of targets: the adjudicator picks (or
declines) a replacement gloss from `candidateGlosses`, and apply_verdicts.py
provenance-checks the choice against this queue — a gloss is never invented.

Suspect = the shared lint signals (scripts/lint_glosses.py): a domain-marked
gloss on a common word, or the templated "related to X" boilerplate. Entries
the deterministic sense-aligned regloss (pipeline/import_es/regloss_legacy.py)
already repaired carry its provenance marker and are skipped; what remains is
exactly the stratum where alignment could not decide (niche glossed senses,
gloss-less dominant translation blocks) and a judgment call is needed.

Candidates per row, best-first:
  - aligned senses (the entry's target appears in that sense's translation
    table), dominance-ordered by full de/fr/it/es table size
  - the word's FIRST sense gloss (Wiktionary page order, tableSize 0) when not
    already present: for words like "death" the dominant sense carries its
    translations in a gloss-less block, so page order is the only signal left.

Needs pipeline/data/en-sense-cache.jsonl (scripts/stream_en_sense_translations.py).

Usage:
    python3 -m pipeline.analysis.build_regloss_queue --language es
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.import_es.regloss_legacy import (
    GLOSS_SOURCE_ID,
    SENSE_CACHE,
    first_clause,
    fold,
    is_suspect,
    load_sense_cache,
    usable_gloss,
)
from .apply_verdicts import GENDERS_BY_LANGUAGE

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKS = REPO_ROOT / "public" / "language-packs"
QUEUES = REPO_ROOT / "pipeline" / "data" / "queues"

CONTENT_POS = {"noun", "verb", "adjective", "adverb"}
MAX_CANDIDATES = 5


def candidate_glosses(slot: dict, target: str) -> list[dict]:
    aligned = [s for s in slot["senses"] if target in s["targets"] and usable_gloss(s["g"])]
    aligned.sort(key=lambda s: -s["n"])
    candidates = []
    seen = set()
    for sense in aligned:
        gloss = first_clause(sense["g"])
        if gloss in seen:
            continue
        seen.add(gloss)
        candidates.append({"gloss": gloss, "tableSize": sense["n"], "aligned": True})
    g0 = slot.get("g0", "")
    if usable_gloss(g0):
        gloss = first_clause(g0)
        if gloss not in seen:
            candidates.append({"gloss": gloss, "tableSize": 0, "aligned": False})
    return candidates[:MAX_CANDIDATES]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--language", required=True, choices=sorted(GENDERS_BY_LANGUAGE))
    args = parser.parse_args()
    language = args.language

    if not SENSE_CACHE.exists():
        raise SystemExit(f"{SENSE_CACHE} missing — build it first (see module docstring)")

    index = load_sense_cache(language)
    rows = []
    skipped_already_repaired = 0
    skipped_no_candidates = 0

    for shard in (PACKS / f"{language}.json", PACKS / f"{language}.tail.json"):
        if not shard.exists():
            continue
        entries = json.loads(shard.read_text())["entries"]
        for key, entry in entries.items():
            pos = entry.get("partOfSpeech")
            if pos not in CONTENT_POS or " " in key:
                continue
            if GLOSS_SOURCE_ID in (entry.get("sourceIds") or []):
                skipped_already_repaired += 1
                continue
            if not is_suspect(entry):
                continue
            slot = index.get((fold(key), pos))
            candidates = candidate_glosses(slot, fold(entry.get("target", ""))) if slot else []
            if not candidates:
                skipped_no_candidates += 1
                continue
            rows.append({
                "key": key,
                "source": entry.get("source", key),
                "target": entry.get("target"),
                "pos": pos,
                "currentGloss": entry.get("sourceGloss"),
                "enZipf": entry.get("enZipf"),
                "eligible": entry.get("eligible", False),
                "candidateGlosses": candidates,
                "glossSourceId": GLOSS_SOURCE_ID,
            })

    rows.sort(key=lambda r: -(r.get("enZipf") or 0))
    QUEUES.mkdir(parents=True, exist_ok=True)
    out = QUEUES / f"regloss-{language}.jsonl"
    with out.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({
        "language": language,
        "queued": len(rows),
        "skippedAlreadyRepaired": skipped_already_repaired,
        "skippedNoCandidates": skipped_no_candidates,
        "queue": str(out.relative_to(REPO_ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
