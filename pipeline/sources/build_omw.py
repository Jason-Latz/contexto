#!/usr/bin/env python3
"""Build the SENSE-DOMINANCE backbone from WordNet + Open Multilingual Wordnet.

For every English lemma in WordNet, this walks its synsets in WordNet's own
sense order (`wn.synsets(lemma)`, which reflects WordNet's frequency-based
sense numbering: rank 1 is the dominant/most-frequent reading) and pulls
target-language lemmas for that synset from the Open Multilingual Wordnet
(OMW), for French, Italian, and Spanish.

Output: one row per (English lemma, sense, language-that-has-a-translation)
in pipeline/data/sources/omw-eng-<lang>.jsonl:

    {"en": str lowercase, "senseRank": int (1 = dominant), "synset": str,
     "gloss": str, "pos": str, "targets": [str]}

`senseRank` is the lemma's position in the FULL WordNet sense list for that
lemma (across all POS, in the order NLTK returns it) -- it is NOT renumbered
after filtering out senses with no target-language translation, so the rank
stays a faithful dominance signal even though (for example) sense 4 might be
the first row that actually appears in a given language's file.

## Cross-sense pooling contamination (fixed 2026-07-12)

Each target lemma is already looked up strictly per-synset --
`syn.lemma_names(omw_code)` is called with the CURRENT synset in the loop,
never pooled across the English lemma's other synsets. Verified directly
against NLTK/OMW with no script code involved at all: e.g.
`wn.synset('die.v.03').lemma_names('fra')` returns `['dé', 'dé_à_jouer',
'décéder', 'mourir']` straight from the underlying
`omw-2.0/fra/wn-data-fra.tab` file at that exact synset's offset key
(`01784953-v`) -- confirmed byte-identical to the pristine upstream
omw-2.0.zip, i.e. not a local corruption. So "dé" (the dice noun) is not a
script-side pooling bug; it is really written into the shipped OMW data at
that offset. This is a known characteristic of the automatically-extended
French WOLF wordnet (Sagot & Fišer 2008): its extension methods attach a
headword's dictionary translations across many/most of that headword's
WordNet senses without per-sense disambiguation (confirmed present in both
omw-1.4 and omw-2.0, so it is not fixable by swapping OMW corpus version).
Spot-checked Italian (MultiWordNet, `ita`) and Spanish (MCR, `spa`) on the
same lemmas and they do NOT show this pattern -- French/WOLF is the main
offender, but the mitigation below runs for all three languages uniformly.

Since we cannot edit the third-party corpus, `_filter_cross_sense_pooling`
below adds a same-lemma disambiguation pass: for a candidate target word that
is attached (by OMW) to more than one of the lemma's senses, it keeps that
word only on the sense(s) whose WordNet `lexname()` (supersense domain, e.g.
`noun.artifact` vs `verb.emotion`) matches the DOMINANT (most common) lexname
among the senses OMW attached it to, and drops it elsewhere. A target
attached to only one sense is never touched -- no pooling is possible there.
This is a heuristic, not an oracle: it trades a little recall (an
occasional legitimately-shared translation gets pruned from a minority
sense) for a large precision gain on the demonstrated failure mode
(a translation for one sense of a polysemous English word leaking onto
semantically unrelated senses of the same word).

German is NOT covered here: OMW (bundled with NLTK as the `omw-2.0` corpus)
ships wordnets for ~30 languages (fra, ita, spa, and others) but no German
data at all -- confirmed empirically (`'deu' not in wn.langs()`, and no
deu/german files anywhere under the unpacked omw-2.0 corpus). The only
credible open German WordNet is the separately-maintained OdeNet project
(github.com/hdaSprachtechnologie/odenet, "Open German WordNet", actively
updated as of 2026-07). It is NOT an NLTK corpus and does not plug into
`wn.synsets(...).lemma_names('deu')` -- it ships its own release format
(a deWordNet.xml file with links to Princeton WordNet 3.0/3.1 synset
offsets) that would need its own loader and offset-mapping step. That
integration is out of scope for this script; see notes in the task output.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from nltk.corpus import wordnet as wn

# language code we use in filenames -> OMW's ISO 639-2/3 code
OMW_LANG_CODES = {
    "fr": "fra",
    "it": "ita",
    "es": "spa",
}


def dedupe_preserve_order(items):
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _filter_cross_sense_pooling(raw_targets_by_synset):
    """Drop targets that OMW pooled across semantically unrelated senses of
    the same English lemma (see module docstring). `raw_targets_by_synset`
    is an ordered {synset: [target, ...]} map for ONE English lemma and ONE
    target language, in senseRank order. Returns a same-shaped map with the
    contaminated (synset, target) pairs removed.

    A target attached to only one synset is untouched (no pooling possible).
    A target attached to several synsets is kept only on the synset(s) whose
    lexname (WordNet supersense domain) matches the most common lexname
    among the synsets OMW attached it to; it is dropped elsewhere.
    """
    target_lexname_counts = defaultdict(Counter)
    for syn, targets in raw_targets_by_synset.items():
        for t in targets:
            target_lexname_counts[t][syn.lexname()] += 1

    dominant_lexname = {
        t: counts.most_common(1)[0][0]
        for t, counts in target_lexname_counts.items()
        if len(counts) > 1  # only ambiguous (multi-synset) targets need a check
    }

    filtered = {}
    for syn, targets in raw_targets_by_synset.items():
        kept = [
            t
            for t in targets
            if t not in dominant_lexname or dominant_lexname[t] == syn.lexname()
        ]
        if kept:
            filtered[syn] = kept
    return filtered


def build(out_dir: Path, limit=None):
    lemmas = sorted(wn.all_lemma_names())
    if limit:
        lemmas = lemmas[:limit]

    out_dir.mkdir(parents=True, exist_ok=True)
    writers = {
        code: open(out_dir / f"omw-eng-{code}.jsonl", "w", encoding="utf-8")
        for code in OMW_LANG_CODES
    }
    counts = {code: 0 for code in OMW_LANG_CODES}
    processed_lemmas = 0

    try:
        for lemma in lemmas:
            synsets = wn.synsets(lemma)
            if not synsets:
                continue
            en = lemma.replace("_", " ").lower()
            processed_lemmas += 1

            for code, omw_code in OMW_LANG_CODES.items():
                # Pull each synset's OWN OMW lemmas for this language --
                # never pooled across the lemma's other synsets.
                raw_targets_by_synset = {}
                for syn in synsets:
                    try:
                        target_lemmas = syn.lemma_names(omw_code)
                    except Exception:
                        target_lemmas = []
                    targets = dedupe_preserve_order(
                        t.replace("_", " ") for t in target_lemmas
                    )
                    if targets:
                        raw_targets_by_synset[syn] = targets

                if not raw_targets_by_synset:
                    continue

                filtered_by_synset = _filter_cross_sense_pooling(raw_targets_by_synset)

                for rank, syn in enumerate(synsets, start=1):
                    targets = filtered_by_synset.get(syn)
                    if not targets:
                        continue
                    row = {
                        "en": en,
                        "senseRank": rank,
                        "synset": syn.name(),
                        "gloss": syn.definition(),
                        "pos": syn.pos(),
                        "targets": targets,
                    }
                    writers[code].write(json.dumps(row, ensure_ascii=False) + "\n")
                    counts[code] += 1
    finally:
        for w in writers.values():
            w.close()

    return processed_lemmas, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parents[1] / "data" / "sources"),
        help="output directory (default: pipeline/data/sources)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="debug: cap number of lemmas processed",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    processed, counts = build(out_dir, limit=args.limit)

    print(f"Processed {processed} English lemmas with at least one synset", file=sys.stderr)
    for code, n in counts.items():
        print(f"  {code}: {n} rows -> {out_dir / f'omw-eng-{code}.jsonl'}", file=sys.stderr)
    print(
        "German: NOT covered (no 'deu' in OMW/nltk wn.langs(); "
        "OdeNet exists as a separate non-NLTK release, needs its own loader).",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
