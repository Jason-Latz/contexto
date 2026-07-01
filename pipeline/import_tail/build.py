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

# The system word list, loaded once in build(); used by is_real_word().
_DICT_WORDS: set[str] = set()

# frequencyRank offset: tail ranks start here so every tail word sorts AFTER every
# core word (cores are ranked 1..~60k), keeping the runtime's freqScore≈0 for tail
# and guaranteeing rank uniqueness within the shard.
RANK_OFFSET = 1_000_000

# The tail is for NICHE vocabulary. Sources at/above this English-frequency (Zipf)
# are common words that (a) belong in core, not a niche shard, and (b) can never be
# rendered anyway — the injector's isReplaceable() gate blocks non-"high" entries at
# enZipf >= 5.0 (MEDIUM_OK_ZIPF). Excluding them here is pure dead-weight/junk removal
# with zero runtime behavior change, and it drops the "the"/"or"/"it" leakage.
NICHE_MAX_ZIPF = 5.0

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
_PHRASE = re.compile(r"[a-z][a-z' -]*")

# Function words that, as part of a multi-word English source, mark it as a
# definitional fragment rather than a real lexical expression. A source phrase
# containing any of these is dropped from the expression tier.
_EXPR_STOPWORDS = {
    "a", "an", "the", "of", "to", "and", "or", "but", "with", "from", "into",
    "for", "by", "at", "on", "in", "as", "that", "which", "is", "are", "be",
    "not", "no", "any", "some", "such", "etc", "one", "someone", "something",
}


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
    # Reject annotation/abbreviation/definitional leakage that Wiktextract sometimes
    # bakes into a translation: bare abbreviations ("comp.", "w.-c.", "dr."), gloss
    # notes ("adj.: leer"), parenthetical scientific names ("Kranich (B. pavonina)"),
    # and "for example …"/"such as …" fragments.
    if any(ch in target for ch in ".():;/"):
        return False
    low = target.lower()
    if "for example" in low or "such as" in low or "e. g" in low:
        return False
    return any(ch.isalpha() for ch in target)


# --- plural derivation (nouns only) --------------------------------------------

_ES_ACUTE_N = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u"}


def _derive_es_plural(target: str) -> str:
    low = target.lower()
    # Oxytone words ending in an accented vowel + n (canción, calderón, común) drop
    # the written accent and add -es: canción→canciones, calderón→calderones.
    if len(low) >= 2 and low[-1] == "n" and low[-2] in _ES_ACUTE_N:
        return target[:-2] + _ES_ACUTE_N[low[-2]] + "nes"
    if low.endswith("z"):
        return target[:-1] + "ces"
    if low.endswith(("s", "x")):
        return target  # often invariant (esp. unstressed) — safe fallback
    if low[-1] in "aeiou":
        return target + "s"
    if low[-1] in "áéíóú":
        return target + "s"  # café→cafés, sofá→sofás
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


def is_real_word(word: str) -> bool:
    """Real English lexical item: in the system dictionary OR known to wordfreq.
    Junk/foreign fragments are in neither. `_DICT_WORDS` is set once in build()."""
    return word in _DICT_WORDS or zipf_frequency(word, "en") > 0


# --- candidate collection ------------------------------------------------------

EN_SOURCE_ID = "wiktextract-en-translations"


class TailCandidate:
    __slots__ = ("source", "pos", "target", "gender", "plural", "gloss", "score", "source_id")

    def __init__(self, source, pos, target, gender, plural, gloss, score, source_id):
        self.source = source
        self.pos = pos
        self.target = target
        self.gender = gender
        self.plural = plural
        self.gloss = gloss
        self.score = score
        self.source_id = source_id


# Classify an English source string into a tail part-of-speech, or None to drop
# it. Single real words keep their dictionary POS; 2-3 word real phrases (no
# leading/definitional function words) become the "expression" tier the product's
# expression scanner already supports; everything else is dropped.
def _source_pos(source: str, rec_pos: str | None) -> str | None:
    n = len(source.split())
    if n == 1:
        if len(source) < 2 or not _SINGLE_WORD.fullmatch(source):
            return None
        if not is_real_word(source):
            return None
        return rec_pos if rec_pos in ("noun", "verb", "adjective", "adverb") else None
    if 2 <= n <= 3:
        if not _PHRASE.fullmatch(source):
            return None
        parts = source.split()
        if _EXPR_STOPWORDS & set(parts):
            return None
        if not all(is_real_word(w) for w in parts):
            return None
        return "expression"
    return None


def collect_english(language: str, cache_path: Path, core_sources: set[str],
                    de_meta: dict[str, tuple[str | None, str | None]]) -> dict[str, TailCandidate]:
    """Tail candidates from the English-Wiktextract translation cache."""
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
            if source in core_sources:
                continue
            pos = _source_pos(source, rec.get("pos"))
            if pos is None:
                continue
            if zipf_frequency(source, "en") >= NICHE_MAX_ZIPF:
                continue  # common word — belongs in core, never rendered from the tail

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
                score = target_freq(target.split()[0]) - 0.5 * (n_words - 1)
                current = best.get(source)
                if current is None or score > current.score:
                    best[source] = TailCandidate(source, pos, target, gender, plural,
                                                 gloss, score, EN_SOURCE_ID)
    return best


def collect_wikt(language: str, extract_path: Path,
                 core_sources: set[str]) -> dict[str, TailCandidate]:
    """Extra tail candidates from a target-language Wiktextract dump, inverted the
    same way the core pipeline does (authoritative gender/plural). Used to reach
    coverage the English translation tables miss — most valuable for Spanish, whose
    core came from FreeDict, not Wiktextract."""
    from pipeline.import_wikt.extract import iter_candidates

    _tf: dict[str, float] = {}

    def target_freq(word: str) -> float:
        if word not in _tf:
            _tf[word] = zipf_frequency(word, language)
        return _tf[word]

    best: dict[str, TailCandidate] = {}
    for cand in iter_candidates(str(extract_path), target_freq, language):
        source = cand.source
        if source in core_sources:
            continue
        if zipf_frequency(source, "en") >= NICHE_MAX_ZIPF:
            continue  # common word — belongs in core, never rendered from the tail
        # Apply the same source gate as the English collector: expressions must be
        # clean 2-3 word phrases; everything else a single real word of that POS.
        expected = None if cand.part_of_speech == "expression" else cand.part_of_speech
        classified = _source_pos(source, expected)
        if cand.part_of_speech == "expression":
            if classified != "expression":
                continue
        elif classified != cand.part_of_speech:
            continue
        if not valid_target(cand.target):
            continue
        current = best.get(source)
        if current is None or cand.score > current.score:
            best[source] = TailCandidate(source, cand.part_of_speech, cand.target,
                                         cand.gender, cand.plural, cand.gloss, cand.score,
                                         f"wiktextract-{language}")
    return best


def build(language: str, cache_path: Path, target_count: int,
          wikt_extract: Path | None) -> tuple[dict, dict]:
    global _DICT_WORDS
    _DICT_WORDS = load_dict_words()
    core_sources = load_core_sources(language)
    core_count = len(core_sources)

    de_meta: dict[str, tuple[str | None, str | None]] = {}
    if language == "de":
        # German plurals are irregular, so they come from the authoritative on-disk
        # dump — without it every German tail noun would be silently dropped.
        if not GERMAN_DUMP.exists():
            sys.exit(f"German tail needs the German Wiktextract dump at {GERMAN_DUMP} "
                     f"(re-download from kaikki.org); refusing to build a noun-less de tail.")
        de_meta = german_metadata()
        print(f"  german plural map: {len(de_meta)} nouns", file=sys.stderr, flush=True)

    best = collect_english(language, cache_path, core_sources, de_meta)
    en_count = len(best)

    # Merge in a target-language Wiktextract inversion (authoritative gender/plural)
    # for sources the English tables missed. Only ADDS new sources — never overwrites
    # an English-tables candidate — so the two sources compose without conflict.
    wikt_count = 0
    if wikt_extract is not None:
        for source, cand in collect_wikt(language, wikt_extract, core_sources).items():
            if source not in best:
                best[source] = cand
                wikt_count += 1

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
            "sourceIds": [cand.source_id],
            "enZipf": round(zipf_frequency(cand.source, "en"), 2),
            "eligible": True,
        }
        if cand.pos == "noun":
            entry["gender"] = cand.gender
            entry["plural"] = cand.plural
        entries[cand.source] = entry
        pos_counts[cand.pos] = pos_counts.get(cand.pos, 0) + 1

    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    sources = {
        EN_SOURCE_ID: {
            "name": "kaikki.org English Wiktextract translation tables",
            "url": "https://kaikki.org/dictionary/English/index.html",
            "license": "CC-BY-SA 4.0 and GFDL",
            "fetchedAt": fetched_at,
            "notes": "Low-confidence niche 'tail' shard: real English words (in "
                     "/usr/share/dict/words or wordfreq) missing from the core pack, "
                     "pointing at a standard translation from the English translation tables.",
        },
    }
    if wikt_count:
        sources[f"wiktextract-{language}"] = {
            "name": f"kaikki.org {DISPLAY[language]} Wiktextract extraction",
            "url": f"https://kaikki.org/dictionary/{DISPLAY[language]}/index.html",
            "license": "CC-BY-SA 4.0 and GFDL",
            "fetchedAt": fetched_at,
            "notes": "Extra tail coverage inverted from target-language Wiktionary senses.",
        }
    pack = {
        "version": fetched_at[:10],
        "sourceLanguage": "en",
        "targetLanguage": language,
        "displayName": DISPLAY[language],
        "sources": sources,
        "entries": entries,
    }
    report = {
        "language": language,
        "coreEntries": core_count,
        "tailEntries": len(entries),
        "corePlusTail": core_count + len(entries),
        "tailByPartOfSpeech": pos_counts,
        "tailFromEnglishTables": en_count,
        "tailAddedFromWiktextract": wikt_count,
        "tailCandidatesAvailable": len(best),
    }
    return pack, report


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a Contexto niche tail shard.")
    parser.add_argument("--language", required=True, choices=sorted(DISPLAY))
    parser.add_argument("--cache", type=Path, default=PROJECT_ROOT / "pipeline" / "data" / "en-tr-cache.jsonl")
    parser.add_argument("--target-count", type=int, default=100000)
    parser.add_argument("--wikt-extract", type=Path, default=None,
                        help="optional target-language Wiktextract JSONL to merge for extra coverage")
    args = parser.parse_args()

    if not args.cache.exists():
        sys.exit(f"translation cache not found: {args.cache}")
    if args.wikt_extract is not None and not args.wikt_extract.exists():
        sys.exit(f"wiktextract dump not found: {args.wikt_extract}")

    pack, report = build(args.language, args.cache, args.target_count, args.wikt_extract)
    out = PACKS / f"{args.language}.tail.json"
    out.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    raw = out.stat().st_size
    gz = len(gzip.compress(out.read_bytes()))
    report["rawBytes"] = raw
    report["gzipBytes"] = gz
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
