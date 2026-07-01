"""Build the quarantined niche "tail" shard: public/language-packs/<lang>.tail.json.

The core pack (<lang>.json) is the curated, frequency-ranked, injectable vocabulary.
The tail is everything else worth having: real English words that are MISSING from
core, mined from the English-Wiktextract `translations` tables (reduced to a small
cache by scripts/stream_en_translations.py). It is low-confidence, lazy-loaded, and
never injected unless the user turns on aggressive mode — so precision matters less
than coverage here, which is exactly the tradeoff the product wants for niche words.

Quality gates that still apply:
  * source must be a real English word (present in /usr/share/dict/words) — this is
    what separates genuine niche vocabulary from the junk/foreign gloss fragments the
    core pipeline drops via its `enZipf > 0` filter;
  * source must not already be in core (no duplicates across shards);
  * the target translation must be standard (regional/obsolete/plural-form tags are
    dropped) and well-formed;
  * nouns must resolve a gender (from the translation tags) AND a plural (derived, or
    for German taken from the authoritative on-disk Wiktextract) so the grammar
    adapters can inflect them — the schema/validator require it.

Usage:
    python3 -m pipeline.import_tail.build --language de \
        --cache pipeline/data/en-tr-cache.jsonl --target-count 100000
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from wordfreq import zipf_frequency

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACKS = PROJECT_ROOT / "public" / "language-packs"
DICT_WORDS = Path("/usr/share/dict/words")
GERMAN_DUMP = PROJECT_ROOT / "pipeline" / "data" / "kaikki.jsonl"

DISPLAY = {"es": "Spanish", "de": "German", "fr": "French", "it": "Italian"}

# frequencyRank offset: tail ranks start here so every tail word sorts AFTER every
# core word (cores are ranked 1..~60k), keeping the runtime's freqScore≈0 for tail
# and guaranteeing rank uniqueness within the shard.
RANK_OFFSET = 1_000_000

# Translation tags that mark a form we don't want as a lemma headword: regional
# variants, dead registers, and inflected (plural) forms.
_SKIP_TAGS = {
    "obsolete", "archaic", "dated", "historical", "dialectal", "dialect", "regional",
    "rare", "nonstandard", "proscribed", "misspelling", "eye-dialect", "plural",
    "Alemannic-German", "Bavarian", "Austrian", "Swiss", "Switzerland", "Liechtenstein",
    "Low-German", "Rhine-Franconian", "Central-Franconian", "Old-High-German",
}

_GENDERS = ("masculine", "feminine", "neuter")
_SINGLE_WORD = re.compile(r"[a-z][a-z'-]*")


def load_dict_words() -> set[str]:
    words: set[str] = set()
    with open(DICT_WORDS, encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            w = line.strip().lower()
            if w:
                words.add(w)
    return words


def load_core_sources(language: str) -> set[str]:
    core = json.loads((PACKS / f"{language}.json").read_text(encoding="utf-8"))
    return set(core["entries"].keys())


def german_metadata() -> dict[str, tuple[str | None, str | None]]:
    """Authoritative {german_word: (gender, plural)} from the on-disk German dump."""
    from pipeline.import_wikt.extract import _gender_of, _plural_of

    meta: dict[str, tuple[str | None, str | None]] = {}
    if not GERMAN_DUMP.exists():
        return meta
    with open(GERMAN_DUMP, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("pos") != "noun":
                continue
            word = (rec.get("word") or "").strip()
            if not word or word in meta:
                continue
            meta[word] = (_gender_of(rec), _plural_of(rec))
    return meta


def gender_from_tags(tags: list[str], language: str) -> str | None:
    for g in _GENDERS:
        if g in tags:
            if g == "neuter" and language != "de":
                return None  # es/fr/it have no neuter — a neuter tag is contamination
            return g
    return None


def valid_target(target: str) -> bool:
    if not (2 <= len(target) <= 40):
        return False
    if any(ch.isdigit() for ch in target):
        return False
    if target.startswith("-") or target.endswith("-"):
        return False
    if len(target.split()) > 3:
        return False
    return any(ch.isalpha() for ch in target)


# --- plural derivation (nouns only) --------------------------------------------

def _derive_es_plural(target: str) -> str:
    low = target.lower()
    if low.endswith("z"):
        return target[:-1] + "ces"
    if low.endswith(("s", "x")):
        return target  # often invariant (esp. unstressed) — safe fallback
    if low[-1] in "aeiou":
        return target + "s"
    if low[-1] in "áéíóú":
        return target + "es"
    return target + "es"


def _derive_fr_plural(target: str) -> str:
    low = target.lower()
    if low.endswith(("s", "x", "z")):
        return target
    if low.endswith("al") and len(target) > 2:
        return target[:-2] + "aux"
    if low.endswith(("eau", "au", "eu")):
        return target + "x"
    return target + "s"


def _derive_it_plural(target: str, gender: str | None) -> str:
    low = target.lower()
    if low.endswith("o"):
        return target[:-1] + "i"
    if low.endswith("a"):
        return target[:-1] + ("i" if gender == "masculine" else "e")
    if low.endswith("e"):
        return target[:-1] + "i"
    return target  # accented / consonant endings are invariant in Italian


def derive_plural(language: str, target: str, gender: str | None,
                  de_meta: dict[str, tuple[str | None, str | None]]) -> str | None:
    if " " in target:
        return None  # multi-word noun target — don't try to inflect
    if language == "de":
        _, plural = de_meta.get(target, (None, None))
        return plural  # authoritative only; None -> drop the noun
    if language == "es":
        return _derive_es_plural(target)
    if language == "fr":
        return _derive_fr_plural(target)
    if language == "it":
        return _derive_it_plural(target, gender)
    return None


def clean_gloss(gloss: str, source: str) -> str:
    text = re.sub(r"\[[^\]]*\]", "", gloss).strip()
    if len(text) > 120:
        text = text[:117].rstrip() + "…"
    return text or source


# --- candidate collection ------------------------------------------------------

class TailCandidate:
    __slots__ = ("source", "pos", "target", "gender", "plural", "gloss", "score")

    def __init__(self, source, pos, target, gender, plural, gloss, score):
        self.source = source
        self.pos = pos
        self.target = target
        self.gender = gender
        self.plural = plural
        self.gloss = gloss
        self.score = score


def collect(language: str, cache_path: Path, words: set[str],
            core_sources: set[str]) -> dict[str, TailCandidate]:
    de_meta = german_metadata() if language == "de" else {}
    if language == "de":
        print(f"  german plural map: {len(de_meta)} nouns", file=sys.stderr, flush=True)

    _tf: dict[str, float] = {}

    def target_freq(word: str) -> float:
        if word not in _tf:
            _tf[word] = zipf_frequency(word, language)
        return _tf[word]

    best: dict[str, TailCandidate] = {}
    with open(cache_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            source = (rec.get("w") or "").strip().lower()
            if len(source) < 2 or not _SINGLE_WORD.fullmatch(source):
                continue
            if source in core_sources:
                continue
            # "Real English word" gate: in the system dictionary OR known to
            # wordfreq. Junk/foreign gloss fragments are in neither and dropped;
            # this admits both niche dictionary words AND common words that the
            # core's target-language source simply never covered.
            if source not in words and zipf_frequency(source, "en") <= 0:
                continue
            pos = rec.get("pos")
            if pos not in ("noun", "verb", "adjective", "adverb"):
                continue

            gloss = clean_gloss(rec.get("g") or "", source)

            for code, target, tags in rec.get("tr", []):
                if code != language:
                    continue
                target = (target or "").strip()
                if not valid_target(target):
                    continue
                if _SKIP_TAGS & set(tags):
                    continue

                gender = plural = None
                if pos == "noun":
                    gender = gender_from_tags(tags, language)
                    if gender is None:
                        continue  # schema requires a gender for nouns
                    plural = derive_plural(language, target, gender, de_meta)
                    if not plural:
                        continue  # schema requires a standalone plural for nouns

                n_words = len(target.split())
                # Prefer: single-word targets, then more common targets. (All that
                # reach here are standard — restricted tags already filtered.)
                score = target_freq(target.split()[0]) - 0.5 * (n_words - 1)

                current = best.get(source)
                if current is None or score > current.score:
                    best[source] = TailCandidate(source, pos, target, gender, plural, gloss, score)
    return best


def build(language: str, cache_path: Path, target_count: int) -> tuple[dict, dict]:
    words = load_dict_words()
    core_sources = load_core_sources(language)
    core_count = len(core_sources)
    best = collect(language, cache_path, words, core_sources)

    # Rank the tail common-first (English frequency), then alphabetically. Cap so
    # core + tail does not exceed the target; keep the most useful (common) first.
    ordered = sorted(best.values(), key=lambda c: (-zipf_frequency(c.source, "en"), c.source))
    room = max(0, target_count - core_count)
    ordered = ordered[:room]

    entries: dict[str, dict] = {}
    pos_counts: dict[str, int] = {}
    for i, cand in enumerate(ordered):
        entry = {
            "source": cand.source,
            "target": cand.target,
            "partOfSpeech": cand.pos,
            "sourceGloss": cand.gloss,
            "frequencyRank": RANK_OFFSET + i,
            "confidence": "low",
            "sourceIds": ["wiktextract-en-translations"],
            "enZipf": round(zipf_frequency(cand.source, "en"), 2),
            "eligible": True,
        }
        if cand.pos == "noun":
            entry["gender"] = cand.gender
            entry["plural"] = cand.plural
        entries[cand.source] = entry
        pos_counts[cand.pos] = pos_counts.get(cand.pos, 0) + 1

    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    pack = {
        "version": fetched_at[:10],
        "sourceLanguage": "en",
        "targetLanguage": language,
        "displayName": DISPLAY[language],
        "sources": {
            "wiktextract-en-translations": {
                "name": "kaikki.org English Wiktextract translation tables",
                "url": "https://kaikki.org/dictionary/English/index.html",
                "license": "CC-BY-SA 4.0 and GFDL",
                "fetchedAt": fetched_at,
                "notes": "Low-confidence niche 'tail' shard: real English words (gated on "
                         "/usr/share/dict/words) missing from the core pack, pointing at a "
                         "standard translation from the English translation tables.",
            },
        },
        "entries": entries,
    }
    report = {
        "language": language,
        "coreEntries": core_count,
        "tailEntries": len(entries),
        "corePlusTail": core_count + len(entries),
        "tailByPartOfSpeech": pos_counts,
        "tailCandidatesAvailable": len(best),
    }
    return pack, report


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a Contexto niche tail shard.")
    parser.add_argument("--language", required=True, choices=sorted(DISPLAY))
    parser.add_argument("--cache", type=Path, default=PROJECT_ROOT / "pipeline" / "data" / "en-tr-cache.jsonl")
    parser.add_argument("--target-count", type=int, default=100000)
    args = parser.parse_args()

    if not args.cache.exists():
        sys.exit(f"translation cache not found: {args.cache}")

    pack, report = build(args.language, args.cache, args.target_count)
    out = PACKS / f"{args.language}.tail.json"
    out.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    raw = out.stat().st_size
    gz = len(gzip.compress(out.read_bytes()))
    report["rawBytes"] = raw
    report["gzipBytes"] = gz
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
