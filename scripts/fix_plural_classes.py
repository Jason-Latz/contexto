#!/usr/bin/env python3
"""Fix two systematic Spanish plural-formation bugs the import introduced
(found via the overnight adversarial audit). Idempotent and conservative.

  CLASS A — multiword "head de complement" nouns: only the HEAD pluralizes; the
    prepositional complement stays singular. The import wrongly pluralized the
    complement (and expanded del->de los):
        informe de viaje   -> informes de viajes   (WRONG)  => informes de viaje
        informe del tiempo -> informes de los tiempos (WRONG) => informes del tiempo
    Fix: plural = (plural's own head) + (singular's connector+complement verbatim).

  CLASS B — agudas ending in stressed -V[ns] drop the written accent in the
    plural (inglés -> ingleses, nación -> naciones). The import kept it
    (albanéses, naciónes). Fix drops the accent — EXCEPT when the accented vowel
    is a weak vowel (i/u) in hiatus with an adjacent vowel (país -> países,
    which correctly KEEPS its accent).

Run: python scripts/fix_plural_classes.py [--dry-run]
"""
import argparse
import json
import re
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent / "public" / "language-packs" / "es.json"
CONN = re.compile(r"(\sde\s|\sdel\s|\sde la\s|\sde los\s|\sde las\s)")
UNACC = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u"}
VOWELS = set("aeiouáéíóú")
AGUDA = re.compile(r"(.)([áéíóú])([ns])es$")


def fix_multiword_de(singular: str, plural: str):
    sp = CONN.split(singular, maxsplit=1)
    pp = CONN.split(plural, maxsplit=1)
    if len(sp) != 3 or len(pp) != 3:
        return plural
    head_p = pp[0]                      # correct pluralized head (informes)
    conn_s, comp_s = sp[1], sp[2]       # singular connector + complement (verbatim)
    return head_p + conn_s + comp_s


def fix_aguda(plural: str) -> str:
    m = AGUDA.search(plural)
    if not m:
        return plural
    prev, vowel, cons = m.group(1), m.group(2), m.group(3)
    # Keep the accent for weak-vowel hiatus (país->países, raíz handled elsewhere).
    if vowel in "íú" and prev and prev.lower() in VOWELS:
        return plural
    return plural[: m.start(2)] + UNACC[vowel] + cons + "es"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pack = json.loads(PACK.read_text())
    a_fixed = b_fixed = 0
    samples_a, samples_b = [], []
    for v in pack["entries"].values():
        if v.get("partOfSpeech") != "noun" or not v.get("plural") or not v.get("target"):
            continue
        target = v["target"].strip()
        plural = v["plural"].strip()

        # Class A — multiword de-phrase
        if CONN.search(target):
            new = fix_multiword_de(target, plural)
            if new != plural:
                if len(samples_a) < 12:
                    samples_a.append((target, plural, new))
                plural = new
                a_fixed += 1

        # Class B — aguda accent drop (also covers single-word agudas)
        new = fix_aguda(plural)
        if new != plural:
            if len(samples_b) < 12:
                samples_b.append((v["target"], plural, new))
            plural = new
            b_fixed += 1

        if plural != v["plural"].strip():
            v["plural"] = plural

    print(f"CLASS A (multiword de-phrase) fixed: {a_fixed}")
    for s in samples_a:
        print("   ", s)
    print(f"CLASS B (aguda accent drop)   fixed: {b_fixed}")
    for s in samples_b:
        print("   ", s)

    if args.dry_run:
        print("\n[dry-run] no file written")
        return
    PACK.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n")
    print("\nwrote", PACK)


if __name__ == "__main__":
    main()
