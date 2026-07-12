#!/usr/bin/env python3
"""Enumerate the candidate universe of English words we could still teach.

Candidate = lowercase alphabetic English lemma (also 2-3 word expressions
ONLY sourced from subtlex_ranked.json, if any exist there), that is a real
word (present in /usr/share/dict/words OR has wordfreq zipf > 0 — dictionary
words with zipf==0 are still included as valid rare words), with
enZipf < 5.0.

For each of es/de/fr/it, loads public/language-packs/<lang>.json and
<lang>.tail.json (READ-ONLY) entries keys to determine which languages
already cover the candidate.

Outputs:
  pipeline/data/universe/en-candidates.jsonl
    {"word": str, "enZipf": float, "missingIn": [...]} for words missing
    in at least one language.
  pipeline/data/universe/summary.json
    per-language missing counts by zipf band.
"""
import json
import re
import sys
from pathlib import Path

from wordfreq import zipf_frequency

REPO_ROOT = Path(__file__).resolve().parents[2]
DICT_WORDS_PATH = Path("/usr/share/dict/words")
SUBTLEX_PATH = REPO_ROOT / "pipeline" / "data" / "subtlex_ranked.json"
PACKS_DIR = REPO_ROOT / "public" / "language-packs"
OUT_DIR = REPO_ROOT / "pipeline" / "data" / "universe"

LANGS = ["es", "de", "fr", "it"]
ZIPF_BANDS = [(0, 0), (0, 1), (1, 2), (2, 3), (3, 4), (4, 5)]
ALPHA_RE = re.compile(r"^[a-z]+$")
PHRASE_RE = re.compile(r"^[a-z]+( [a-z]+){1,2}$")  # 2-3 word expressions


def load_dict_words():
    words = set()
    with open(DICT_WORDS_PATH, encoding="latin-1") as f:
        for line in f:
            w = line.strip().lower()
            if ALPHA_RE.match(w):
                words.add(w)
    return words


def load_subtlex_phrases():
    """subtlex_ranked.json is keyed by word/phrase -> rank. Only pull entries
    that are 2-3 word alphabetic expressions (lowercased); single words in
    this file are not English (this particular cache is a German-frequency
    list), so we do not use it as an English single-word source."""
    phrases = set()
    if not SUBTLEX_PATH.exists():
        return phrases
    try:
        d = json.loads(SUBTLEX_PATH.read_text())
    except Exception:
        return phrases
    if isinstance(d, dict):
        keys = d.keys()
    elif isinstance(d, list):
        keys = d
    else:
        keys = []
    for k in keys:
        if not isinstance(k, str):
            continue
        lk = k.lower().strip()
        if PHRASE_RE.match(lk):
            phrases.add(lk)
    return phrases


def load_pack_keys(lang):
    keys = set()
    for suffix in ("json", "tail.json"):
        p = PACKS_DIR / f"{lang}.{suffix}"
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        entries = d.get("entries", {})
        if isinstance(entries, dict):
            keys.update(k.lower() for k in entries.keys())
        elif isinstance(entries, list):
            for e in entries:
                src = e.get("source") if isinstance(e, dict) else None
                if src:
                    keys.add(src.lower())
    return keys


def zipf_band(z):
    if z <= 0:
        return "0"
    if z < 1:
        return "0-1"
    if z < 2:
        return "1-2"
    if z < 3:
        return "2-3"
    if z < 4:
        return "3-4"
    return "4-5"


def main():
    print("Loading /usr/share/dict/words...", file=sys.stderr)
    dict_words = load_dict_words()
    print(f"  {len(dict_words)} alphabetic dict words", file=sys.stderr)

    print("Loading subtlex phrases (2-3 word expressions only)...", file=sys.stderr)
    subtlex_phrases = load_subtlex_phrases()
    print(f"  {len(subtlex_phrases)} multi-word phrases", file=sys.stderr)

    print("Loading language pack keys (es/de/fr/it, core+tail)...", file=sys.stderr)
    pack_keys = {lang: load_pack_keys(lang) for lang in LANGS}
    for lang in LANGS:
        print(f"  {lang}: {len(pack_keys[lang])} keys", file=sys.stderr)

    # Build candidate pool: dict words (single word) + subtlex phrases,
    # plus any wordfreq single words with zipf>0 not already in dict_words
    # (wordfreq top list gives extra real English words dict may miss).
    print("Building candidate pool...", file=sys.stderr)
    candidates = set(dict_words) | subtlex_phrases

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "en-candidates.jsonl"
    summary = {lang: {band[0] if isinstance(band, str) else f"{band}": 0 for band in []} for lang in LANGS}
    # init summary bands properly
    band_names = ["0", "0-1", "1-2", "2-3", "3-4", "4-5"]
    summary = {lang: {b: 0 for b in band_names} for lang in LANGS}
    total_candidates = 0
    total_emitted = 0

    with open(out_path, "w") as out:
        for word in sorted(candidates):
            z = zipf_frequency(word, "en")
            in_dict = word in dict_words
            if not in_dict and z <= 0:
                continue  # not a real word (not in dict, no frequency signal)
            if z >= 5.0:
                continue
            total_candidates += 1
            missing_in = [lang for lang in LANGS if word not in pack_keys[lang]]
            band = zipf_band(z)
            for lang in missing_in:
                summary[lang][band] += 1
            if missing_in:
                out.write(json.dumps({
                    "word": word,
                    "enZipf": round(z, 2),
                    "missingIn": missing_in,
                }) + "\n")
                total_emitted += 1

    summary_path = OUT_DIR / "summary.json"
    summary_out = {
        "totalCandidates": total_candidates,
        "totalEmittedRows": total_emitted,
        "missingCountsByZipfBand": summary,
    }
    summary_path.write_text(json.dumps(summary_out, indent=2))

    print(json.dumps(summary_out, indent=2))


if __name__ == "__main__":
    main()
