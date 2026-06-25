#!/usr/bin/env python3
"""Annotate a language pack with quality/eligibility signals — offline, no API.

The bundled pack mixes ~2.3k hand-verified ("high") entries with a large imported
("medium") tier. Wrong-sense errors and the words a learner already knows are the
SAME set: common English words. So the strategy is:

  1. enZipf  — English frequency (Zipf) of the source word, from `wordfreq`.
               Lets the runtime skip words the learner already knows (by level) and
               require verification for the error-prone common band.
  2. eligible — content part-of-speech only (drop function words), minus a small
               quarantine of WordNet-polysemous sources (where wrong senses cluster).
  3. fixes   — a curated handful of audit-flagged bad targets corrected and promoted
               to "high" so they render correctly.

It also emits a paste-ready batch of common medium words for ChatGPT/Codex
verification (no API cost), so coverage of the common band can grow over time.

Run:  pip install wordfreq  &&  python scripts/qa_language_pack.py
"""
import argparse
import json
import sys
from pathlib import Path

try:
    from wordfreq import zipf_frequency
except ImportError:
    sys.exit("wordfreq is required: pip install wordfreq")

ROOT = Path(__file__).resolve().parent.parent
POLY = ROOT / "pipeline" / "data" / "polysemous.json"

CONTENT_POS = {"noun", "adverb", "adjective", "verb", "expression"}

# Above this English-Zipf, a MEDIUM entry is too common to trust (its dominant
# sense is where the import goes wrong) and is gated out at runtime unless it is
# "high". Mirrored by MEDIUM_OK_ZIPF in src/content/injector.ts — keep in sync.
COMMON_BAND_ZIPF = 5.0

# Audit-flagged bad targets, corrected and promoted to high confidence so they
# render correctly instead of being gated/odd. Nouns carry gender + plural.
FIXES = {
    "small":           {"target": "pequeño"},
    "native american": {"target": "nativo americano"},
    "armed conflict":  {"target": "conflicto armado"},
    "your mother":     {"target": "tu madre"},
    "butt":            {"target": "trasero", "gender": "masculine", "plural": "traseros"},
    "cock":            {"target": "gallo", "gender": "masculine", "plural": "gallos"},
    "pullet":          {"target": "pollita", "gender": "feminine", "plural": "pollitas"},
    "old maid":        {"target": "solterona"},
    "billy goat":      {"target": "macho cabrío"},
}


def load_polysemous():
    if not POLY.exists():
        return set()
    raw = json.loads(POLY.read_text())
    return {w.lower() for w in raw}


def main():
    parser = argparse.ArgumentParser(description="Annotate a language pack with quality signals.")
    parser.add_argument("--language", default="es")
    args = parser.parse_args()
    language = args.language

    pack_path = ROOT / "public" / "language-packs" / f"{language}.json"
    verify_out = ROOT / "imports" / "language-packs" / language / "common-words-to-verify.json"
    # The curated FIXES are Spanish targets; only apply them to the Spanish pack.
    fixes = FIXES if language == "es" else {}

    data = json.loads(pack_path.read_text())
    entries = data["entries"]
    poly = load_polysemous()

    fixed = 0
    eligible_count = 0
    dropped_function = 0
    dropped_polysemous = 0
    verify_batch = []

    for key, entry in entries.items():
        source = entry.get("source", key).lower()

        # Apply curated fixes (correct target, promote to high).
        if source in fixes:
            fix = fixes[source]
            entry["target"] = fix["target"]
            if "gender" in fix:
                entry["gender"] = fix["gender"]
            if "plural" in fix:
                entry["plural"] = fix["plural"]
            entry["confidence"] = "high"
            fixed += 1

        # English frequency of the source word (the known-words / error-band lever).
        entry["enZipf"] = round(zipf_frequency(source, "en"), 2)

        pos = entry.get("partOfSpeech")
        is_polysemous = source in poly or source.rstrip("s") in poly
        eligible = pos in CONTENT_POS and not is_polysemous

        entry["eligible"] = eligible
        if eligible:
            eligible_count += 1
        elif pos not in CONTENT_POS:
            dropped_function += 1
        elif is_polysemous:
            dropped_polysemous += 1

        # Common medium words are gated out for quality — collect them as a
        # ready-to-verify batch (translate in chat, promote to high later).
        if (eligible and entry.get("confidence") == "medium"
                and entry["enZipf"] >= COMMON_BAND_ZIPF):
            verify_batch.append({
                "source": entry.get("source", key),
                "partOfSpeech": pos,
                "currentTarget": entry.get("target"),
                "gloss": entry.get("sourceGloss", ""),
                "enZipf": entry["enZipf"],
            })

    pack_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    verify_batch.sort(key=lambda e: -e["enZipf"])
    verify_out.parent.mkdir(parents=True, exist_ok=True)
    verify_out.write_text(json.dumps(verify_batch, ensure_ascii=False, indent=2) + "\n")

    total = len(entries)
    print(f"entries:            {total}")
    print(f"curated fixes:      {fixed}")
    print(f"eligible (content): {eligible_count}")
    print(f"dropped function:   {dropped_function}")
    print(f"dropped polysemous: {dropped_polysemous}")
    print(f"common-band verify batch: {len(verify_batch)} -> {verify_out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
