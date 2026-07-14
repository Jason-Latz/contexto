"""Reduce the 3GB English Wiktextract dump to a SENSE-LEVEL translation cache.

Unlike scripts/stream_en_translations.py (which merges every sense's
translations into one row and keeps only the first sense's gloss), this keeps
each sense separate: gloss + that sense's own translation table. That is what
sense-ALIGNED reglossing needs — given an entry (source, pos, target), find the
sense whose target-language translations contain the target, and its gloss is
then a definition of exactly the sense the entry teaches.

    curl -s https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl \
        | python3 scripts/stream_en_sense_translations.py pipeline/data/en-sense-cache.jsonl

Each output line:
    {"w": word, "pos": contexto_pos,
     "senses": [{"g": gloss, "tr": [[code, target, [tags...]], ...]}, ...],
     "g0": first_sense_gloss}

Only content parts of speech; only records with at least one de/fr/it/es
translation somewhere. Word-level translation tables (Wiktextract sometimes
attaches them to the record instead of a sense) are kept as a sense with
gloss "" so alignment can still use them, with g0 as the gloss fallback.
"""
from __future__ import annotations

import json
import sys

WANT = {"de", "fr", "it", "es"}
POS_MAP = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb"}


def picked_translations(translations: list) -> list:
    picked = []
    seen = set()
    for t in translations or []:
        code = t.get("code") or t.get("lang_code")
        if code not in WANT:
            continue
        target = (t.get("word") or "").strip()
        if not target or target in ("-", "—"):
            continue
        key = (code, target)
        if key in seen:
            continue
        seen.add(key)
        picked.append([code, target, t.get("tags") or []])
    return picked


def main() -> None:
    out_path = sys.argv[1]
    kept = 0
    scanned = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            scanned += 1
            if scanned % 100000 == 0:
                print(f"  scanned={scanned} kept={kept}", file=sys.stderr, flush=True)
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pos = POS_MAP.get(rec.get("pos"))
            if pos is None:
                continue
            word = (rec.get("word") or "").strip()
            if not word:
                continue

            senses_out = []
            record_senses = rec.get("senses") or []
            g0 = ""
            for s in record_senses:
                gl = s.get("glosses") or []
                if gl and not g0:
                    g0 = gl[0]
                tr = picked_translations(s.get("translations"))
                if tr:
                    senses_out.append({"g": gl[0] if gl else "", "tr": tr})

            word_level = picked_translations(rec.get("translations"))
            if word_level:
                senses_out.append({"g": "", "tr": word_level})

            if not senses_out:
                continue
            out.write(json.dumps({"w": word, "pos": pos, "senses": senses_out, "g0": g0},
                                 ensure_ascii=False) + "\n")
            kept += 1
    print(f"DONE scanned={scanned} kept={kept} -> {out_path}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
