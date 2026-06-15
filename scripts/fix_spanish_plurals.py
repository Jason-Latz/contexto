#!/usr/bin/env python3
"""Correct systematic Spanish plural errors in the language pack (idempotent).

The imported tier mis-formed two classes of plurals (found via a rare-tail audit):
  1. Accent retention: a noun ending in a stressed -ón/-án/-én/-ín/-ún drops its
     written accent in the plural (nación -> naciones), but the import kept it
     (naciónes). Affected ~1,800 nouns, mostly the productive -ción/-sión/-ización
     family.
  2. -sis/-xis nouns are invariable (crisis -> crisis; anamorfosis -> anamorfosis),
     but the import pluralized them.

Both rules are safe to apply pack-wide. Run:  python scripts/fix_spanish_plurals.py
"""
import json
import re
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent / "public" / "language-packs" / "es.json"
ACCENT = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u"}
ACCENT_NES = re.compile(r"(á|é|í|ó|ú)(nes)$")


def fix_plural(plural: str) -> str:
    # Drop the written accent on a stressed final vowel before the -nes plural
    # ending (…ciónes -> …ciones, Ivánes -> Ivanes).
    return ACCENT_NES.sub(lambda m: ACCENT[m.group(1)] + "nes", plural)


def main():
    pack = json.loads(PACK.read_text())
    accent_fixed = invariable_fixed = 0
    for v in pack["entries"].values():
        if v.get("partOfSpeech") != "noun" or not v.get("plural"):
            continue
        new_plural = fix_plural(v["plural"])
        if new_plural != v["plural"]:
            v["plural"] = new_plural
            accent_fixed += 1
        target = v["target"]
        if " " not in target and re.search(r"(sis|xis)$", target) and v["plural"] != target:
            v["plural"] = target  # invariable
            invariable_fixed += 1
    PACK.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n")
    print(f"accent-drop plural fixes: {accent_fixed}")
    print(f"-sis invariable fixes:    {invariable_fixed}")


if __name__ == "__main__":
    main()
