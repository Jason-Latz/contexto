#!/usr/bin/env python3
"""Build the mint trial sample: a small stratified random sample drawn from the
mint queues (pipeline/data/queues/mint-{de,fr,it,es}.jsonl) for a quick trial
run of the adjudication engine before committing to the full mint batches.

Stratified random sample (seed 20260712), fixed per-language counts:
  de 150, fr 70, it 90, es 50

Each stratum is sampled without replacement from its full mint-{lang}.jsonl
queue, then all four strata are combined and shuffled together (continuing
the same seeded RNG) so the mixed file doesn't just run language-by-language.

Writes:
  pipeline/data/queues/minttrial-mixed.jsonl -- the sampled rows, each keeping
    its original `lang` field, mixed + shuffled across languages.

This script only READS the mint queues; it never writes to public/language-packs/.
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
QUEUES_DIR = REPO_ROOT / "pipeline" / "data" / "queues"

RANDOM_SEED = 20260712
SAMPLE_COUNTS = {"de": 150, "fr": 70, "it": 90, "es": 50}
LANGUAGES = ["de", "fr", "it", "es"]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_mint_rows(lang: str) -> list[dict]:
    path = QUEUES_DIR / f"mint-{lang}.jsonl"
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> None:
    rng = random.Random(RANDOM_SEED)

    sampled: list[dict] = []
    counts_taken = {}
    for lang in LANGUAGES:
        rows = load_mint_rows(lang)
        n = SAMPLE_COUNTS[lang]
        if len(rows) < n:
            raise ValueError(f"mint-{lang}.jsonl has only {len(rows)} rows, need {n}")
        chosen = rng.sample(rows, n)
        sampled.extend(chosen)
        counts_taken[lang] = len(chosen)
        log(f"=== {lang} === sampled {len(chosen)}/{len(rows)}")

    rng.shuffle(sampled)

    out_path = QUEUES_DIR / "minttrial-mixed.jsonl"
    with open(out_path, "w", encoding="utf-8") as fout:
        for rec in sampled:
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")

    log(f"=== SUMMARY === {json.dumps(counts_taken)} -> {out_path}")
    print(json.dumps({"counts": counts_taken, "rows": len(sampled)}, indent=2))


if __name__ == "__main__":
    main()
