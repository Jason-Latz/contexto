#!/usr/bin/env python3
"""Build the blind gold2 adjudication queue (mixed across de/fr/it/es).

Reuses pipeline/analysis/build_audit_queue.py's loaders/enrichment (same pack
+ evidence + cross-reference indexes, same `enrich_entry` shape) to enrich
every row named in pipeline/data/gold2/gold2-{de,fr,it,es}.jsonl -- these are
a second, independently-labeled gold set (distinct from pipeline/data/gold/).

This script only READS pack files; it never writes to public/language-packs/.

Writes:
  pipeline/data/queues/gold2-mixed.jsonl   -- enriched rows for every gold2
    key, all four languages mixed together and shuffled (seed 20260712), with
    NO verdict fields (blind).
  pipeline/data/queues/gold2-answers.jsonl -- the withheld verdict fields for
    every gold2-mixed row, in the SAME shuffled order, joined by (lang, key).
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from pipeline.analysis.build_audit_queue import (  # noqa: E402
    build_indexes,
    enrich_entry,
    load_entr_buckets,
    load_evidence,
    load_pack_entries,
    log,
    _find_pack_key,
)

GOLD2_DIR = REPO_ROOT / "pipeline" / "data" / "gold2"
QUEUES_DIR = REPO_ROOT / "pipeline" / "data" / "queues"

LANGUAGES = ["de", "fr", "it", "es"]
RANDOM_SEED = 20260712


def load_gold2_rows(lang: str) -> list[dict]:
    path = GOLD2_DIR / f"gold2-{lang}.jsonl"
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> None:
    QUEUES_DIR.mkdir(parents=True, exist_ok=True)

    log("loading shared en-tr-cache index ...")
    t0 = time.time()
    entr_shared = load_entr_buckets()
    log(f"  {len(entr_shared)} keys in {time.time() - t0:.1f}s")

    pairs: list[tuple[dict, dict]] = []  # (queue_row, answer_row), built in lang order

    for lang in LANGUAGES:
        t0 = time.time()
        entries = load_pack_entries(lang)
        evidence = load_evidence(lang)
        indexes = build_indexes(lang, entr_shared)
        rows = load_gold2_rows(lang)

        n_found = 0
        for r in rows:
            key = r.get("key")
            if key not in entries:
                key = _find_pack_key(entries, r.get("source") or key)
            if key is None or key not in entries:
                log(f"WARNING: gold2 row lang={lang} key={r.get('key')!r} "
                    f"source={r.get('source')!r} has no matching pack entry, skipping")
                continue
            n_found += 1

            entry = entries[key]
            evidence_rec = evidence.get(key)
            queue_row = enrich_entry(lang, key, entry, evidence_rec, indexes)
            answer_row = {
                "lang": lang,
                "key": key,
                "source": r.get("source"),
                "verdict": r.get("verdict"),
                "correctedTarget": r.get("correctedTarget"),
                "correctedGender": r.get("correctedGender"),
                "correctedPlural": r.get("correctedPlural"),
                "genderOk": r.get("genderOk"),
                "pluralOk": r.get("pluralOk"),
                "rationale": r.get("rationale"),
            }
            pairs.append((queue_row, answer_row))
        log(f"=== {lang} === {n_found}/{len(rows)} matched ({time.time() - t0:.1f}s)")

    rng = random.Random(RANDOM_SEED)
    rng.shuffle(pairs)

    with open(QUEUES_DIR / "gold2-mixed.jsonl", "w", encoding="utf-8") as f:
        for queue_row, _ in pairs:
            f.write(json.dumps(queue_row, ensure_ascii=False) + "\n")
    with open(QUEUES_DIR / "gold2-answers.jsonl", "w", encoding="utf-8") as f:
        for _, answer_row in pairs:
            f.write(json.dumps(answer_row, ensure_ascii=False) + "\n")

    result = {"rows": len(pairs)}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
