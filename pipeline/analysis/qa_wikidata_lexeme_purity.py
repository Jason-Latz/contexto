#!/usr/bin/env python3
"""QA check for pipeline/data/sources/wikidata-lexemes-{de,fr,it,es}.jsonl.

Context: these files are our gender/plural morphology authority (schema:
{"lemma","gender","plural","lexemeId"}), extracted by
pipeline/sources/fetch_wikidata_lexemes.py from the official Wikidata
lexemes dump, filtered by exact language QID
(LANGUAGE_QID_TO_CODE = {Q188: de, Q150: fr, Q652: it, Q1321: es}).

2026-07-12 investigation found real but low-rate cross-language
contamination (e.g. Portuguese "conservadorismo"/"jaqueta" tagged as
Spanish). Spot-checking the raw dump for every flagged case confirmed the
lexeme's own "language" field already carries the exact matching QID -
i.e. this is a Wikidata community data-entry error (a contributor tagged
a Portuguese word under the Spanish lexeme), NOT a bug in the QID filter
in fetch_wikidata_lexemes.py. No code fix to that script is warranted;
this script is a reusable statistical flagger for a future manual-review /
filtering pass over the extracted jsonl files (it does not modify them).

Heuristic: for each lemma, compare its wordfreq zipf frequency in the
target language against its most confusable neighbor language(s). A large
positive gap (neighbor recognizes it well, target barely/never does) is a
candidate for contamination. This is a noisy proxy - many flagged lemmas
are legitimate shared Romance cognates / naturalized loanwords, not
contamination (empirically ~60-70% precision on manual spot-check for
es->pt; lower for it, since it shares more genuine vocabulary with both
es and pt). Treat output as a manual-review shortlist, not ground truth.

Usage:
  pip3 install --user --break-system-packages wordfreq   # if not present
  python3 pipeline/analysis/qa_wikidata_lexeme_purity.py \
      --out pipeline/data/qa_wikidata_lexeme_contamination_candidates.jsonl
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from wordfreq import zipf_frequency

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE.parent / "data" / "sources"

# Most plausible contamination vector per language, based on manual
# confirmation (es<-pt: conservadorismo, jaqueta; it<-pt/es: reconquista,
# gasosa, quilombola; de<-nl: weakest signal, mostly false positives).
NEIGHBORS = {
    "es": ["pt"],
    "fr": ["pt"],
    "it": ["pt", "es"],
    "de": ["nl"],
}

GAP_THRESHOLD = 1.5   # neighbor_zipf - target_zipf must be at least this
MIN_NEIGHBOR_ZIPF = 3.0  # neighbor must recognize it as a common word


def load_lemmas(lang: str) -> list[dict]:
    path = DATA_DIR / f"wikidata-lexemes-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def scan(lang: str) -> list[dict]:
    rows = load_lemmas(lang)
    hits = []
    for row in rows:
        lemma = row["lemma"]
        target_z = zipf_frequency(lemma, lang)
        best_nb, best_nz = None, -1.0
        for nb in NEIGHBORS.get(lang, []):
            nz = zipf_frequency(lemma, nb)
            if nz > best_nz:
                best_nb, best_nz = nb, nz
        if best_nz - target_z >= GAP_THRESHOLD and best_nz >= MIN_NEIGHBOR_ZIPF:
            hits.append({
                "lang": lang,
                "lemma": lemma,
                "lexemeId": row["lexemeId"],
                "target_zipf": target_z,
                "neighbor_lang": best_nb,
                "neighbor_zipf": best_nz,
            })
    return hits


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--languages", nargs="+", default=["de", "fr", "it", "es"])
    ap.add_argument("--out", type=Path, default=None,
                    help="write flagged candidates as jsonl (one per line)")
    args = ap.parse_args()

    all_hits = []
    for lang in args.languages:
        hits = scan(lang)
        n = len(load_lemmas(lang))
        print(f"{lang}: {len(hits)}/{n} flagged ({100 * len(hits) / n:.2f}%)")
        all_hits.extend(hits)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            for h in all_hits:
                f.write(json.dumps(h, ensure_ascii=False) + "\n")
        print(f"wrote {len(all_hits)} candidates to {args.out}")


if __name__ == "__main__":
    main()
