#!/usr/bin/env python3
"""Merge a verified common-band curation into the language pack.

Input: a JSON file {curated: [{source, target, partOfSpeech, gender, plural}], skipped: [source, ...]}
(the output of the curation workflow). Promotes each kept word to confidence:"high"
+ eligible:true with the verified translation; marks each skipped word eligible:false.

Run:  python scripts/apply_curation.py <curation.json>
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "public" / "language-packs" / "es.json"
CONTENT_POS = {"noun", "verb", "adjective", "adverb", "expression"}


def find(entries, source):
    return entries.get(source) or entries.get(source.lower())


def main(curation_path):
    data = json.loads(PACK.read_text())
    entries = data["entries"]
    cur = json.loads(Path(curation_path).read_text())

    promoted = missing = incomplete = skipped_applied = 0

    for k in cur.get("curated", []):
        e = find(entries, k["source"])
        if not e:
            missing += 1
            continue
        target = (k.get("target") or "").strip()
        if not target:
            incomplete += 1
            continue
        pos = (k.get("partOfSpeech") or e["partOfSpeech"]).strip() or e["partOfSpeech"]
        if pos not in CONTENT_POS:
            incomplete += 1
            continue
        if pos == "noun":
            gender = (k.get("gender") or e.get("gender") or "").strip()
            plural = (k.get("plural") or e.get("plural") or "").strip()
            if gender not in ("masculine", "feminine") or not plural:
                incomplete += 1  # a noun without valid gender/plural can't render
                continue
            e["gender"] = gender
            e["plural"] = plural
        else:
            e.pop("gender", None)
            e.pop("plural", None)
            e.pop("functionSubtype", None)
        e["target"] = target
        e["partOfSpeech"] = pos
        e["confidence"] = "high"
        e["eligible"] = True
        promoted += 1

    for s in cur.get("skipped", []):
        e = find(entries, s)
        if e:
            e["eligible"] = False
            skipped_applied += 1

    PACK.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"promoted to high:   {promoted}")
    print(f"marked ineligible:  {skipped_applied}")
    print(f"missing source:     {missing}")
    print(f"incomplete/skipped: {incomplete}")

    # Spot-report a few words used by tests / the audit.
    for w in ["world", "snack", "number", "it", "small", "anodization"]:
        e = find(entries, w)
        if e:
            print(f"  {w}: target={e['target']!r} conf={e['confidence']} "
                  f"eligible={e.get('eligible')} enZipf={e.get('enZipf')} pos={e['partOfSpeech']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/apply_curation.py <curation.json>")
    main(sys.argv[1])
