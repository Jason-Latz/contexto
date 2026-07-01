"""Reduce the 3GB English Wiktextract dump to a small de/fr/it/es translation cache.

Reads the kaikki.org English dump JSONL on STDIN (so it can be streamed straight
from curl without ever storing the 3GB file) and writes a compact JSONL cache
containing only the fields the tail builder needs, only for content parts of
speech, and only for records that carry at least one German/French/Italian/
Spanish translation.

    curl -s <english-dump-url> | python3 scripts/stream_en_translations.py \
        pipeline/data/en-tr-cache.jsonl

Each output line: {"w": source, "pos": contexto_pos, "g": gloss,
                   "tr": [[code, target, [tags...]], ...]}   # only de/fr/it/es
"""
from __future__ import annotations

import json
import sys

WANT = {"de", "fr", "it", "es"}
POS_MAP = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb"}


def main() -> None:
    out_path = sys.argv[1]
    kept = 0
    scanned = 0
    tr_total = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            scanned += 1
            if scanned % 100000 == 0:
                print(f"  scanned={scanned} kept={kept} tr={tr_total}", file=sys.stderr, flush=True)
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
            # Wiktextract puts translations both at the top level AND per sense;
            # the sense-level tables are ~5x more common, so gather both.
            translations = list(rec.get("translations") or [])
            for sense in rec.get("senses") or []:
                translations.extend(sense.get("translations") or [])
            if not translations:
                continue
            picked = []
            seen_pairs = set()
            for t in translations:
                code = t.get("code") or t.get("lang_code")
                if code not in WANT:
                    continue
                target = (t.get("word") or "").strip()
                if not target or target in ("-", "—"):
                    continue
                key = (code, target)
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                picked.append([code, target, t.get("tags") or []])
            if not picked:
                continue
            senses = rec.get("senses") or []
            gloss = ""
            for s in senses:
                gl = s.get("glosses") or []
                if gl:
                    gloss = gl[0]
                    break
            out.write(json.dumps({"w": word, "pos": pos, "g": gloss, "tr": picked},
                                 ensure_ascii=False) + "\n")
            kept += 1
            tr_total += len(picked)
    print(f"DONE scanned={scanned} kept={kept} translations={tr_total} -> {out_path}",
          file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
