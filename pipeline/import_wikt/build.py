"""Build public/language-packs/<lang>.json from a Wiktextract extract.

Usage: python -m pipeline.import_wikt.build --language de
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from wordfreq import zipf_frequency

from .extract import Candidate, iter_candidates

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE = PROJECT_ROOT / "pipeline" / "data" / "wikt-cache"
PACKS = PROJECT_ROOT / "public" / "language-packs"
LOCKS = PROJECT_ROOT / "pipeline" / "sources"

# Contexto language code → (Wiktextract file stem, display name, kaikki dictionary slug).
LANGUAGES = {
    "de": ("German", "German", "German"),
    "fr": ("French", "French", "French"),
    "it": ("Italian", "Italian", "Italian"),
}

COMMON_BAND_ZIPF = 5.0  # mirrors scripts/qa_language_pack.py


# English frequency of the source (the runtime's known-words / common-band lever).
# wordfreq scores multi-word phrases natively, so the same call is used for single
# words and expressions — and it MUST match scripts/qa_language_pack.py so that
# re-running QA over a generated pack is a no-op.
def _en_zipf(source: str) -> float:
    return round(zipf_frequency(source, "en"), 2)


def _clean_gloss(gloss: str, source: str) -> str:
    text = gloss.replace("[", "").replace("]", "").strip()
    if len(text) > 120:
        text = text[:117].rstrip() + "…"
    return text or source


def collect(language: str, extract_path: Path) -> dict[str, Candidate]:
    """Best candidate per English lemma (highest score across senses/POS)."""
    target_lang = language
    cache: dict[str, float] = {}

    def target_freq(word: str) -> float:
        if word not in cache:
            cache[word] = zipf_frequency(word, target_lang)
        return cache[word]

    best: dict[str, Candidate] = {}
    for cand in iter_candidates(str(extract_path), target_freq, target_lang):
        # Drop non-English / junk source pieces: a real English lemma is known to
        # wordfreq. This also filters mis-split foreign glosses.
        if _en_zipf(cand.source) <= 0:
            continue
        current = best.get(cand.source)
        if current is None or cand.score > current.score:
            best[cand.source] = cand
    return best


def to_entry(source: str, cand: Candidate, rank: int, source_id: str) -> dict:
    entry = {
        "source": source,
        "target": cand.target,
        "partOfSpeech": cand.part_of_speech,
        "sourceGloss": _clean_gloss(cand.gloss, source),
        "frequencyRank": rank,
        "confidence": "medium",
        "sourceIds": [source_id],
        "enZipf": _en_zipf(source),
        "eligible": True,
    }
    if cand.part_of_speech == "noun":
        entry["gender"] = cand.gender
        entry["plural"] = cand.plural
    return entry


def build(language: str, extract_path: Path) -> dict:
    file_stem, display_name, slug = LANGUAGES[language]
    source_id = f"wiktextract-{language}"
    best = collect(language, extract_path)

    # Rank by English frequency (common first), then translation quality. Unique
    # integer ranks are required by the validator.
    ordered = sorted(
        best.items(),
        key=lambda kv: (-_en_zipf(kv[0]), -kv[1].score, kv[0]),
    )

    entries = {}
    for rank, (source, cand) in enumerate(ordered, start=1):
        entries[source] = to_entry(source, cand, rank, source_id)

    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    return {
        "version": fetched_at[:10],
        "sourceLanguage": "en",
        "targetLanguage": language,
        "displayName": display_name,
        "sources": {
            source_id: {
                "name": f"kaikki.org {display_name} Wiktextract extraction",
                "url": f"https://kaikki.org/dictionary/{slug}/index.html",
                "license": "CC-BY-SA 4.0 and GFDL",
                "fetchedAt": fetched_at,
                "notes": "English→target entries inverted from target-language Wiktionary "
                         "senses; gender + plural taken from the headword's grammatical forms.",
            },
        },
        "entries": entries,
    }


def write_pack(language: str, pack: dict) -> dict:
    PACKS.mkdir(parents=True, exist_ok=True)
    out = PACKS / f"{language}.json"
    raw = json.dumps(pack, ensure_ascii=False, indent=2) + "\n"
    out.write_text(raw, encoding="utf-8")

    raw_bytes = len(raw.encode("utf-8"))
    gzip_bytes = len(gzip.compress(raw.encode("utf-8")))
    pos_counts: dict[str, int] = {}
    common = 0
    for entry in pack["entries"].values():
        pos_counts[entry["partOfSpeech"]] = pos_counts.get(entry["partOfSpeech"], 0) + 1
        if entry["enZipf"] >= COMMON_BAND_ZIPF:
            common += 1
    report = {
        "language": language,
        "entries": len(pack["entries"]),
        "byPartOfSpeech": pos_counts,
        "commonBand(enZipf>=5)": common,
        "rawBytes": raw_bytes,
        "gzipBytes": gzip_bytes,
    }

    LOCKS.mkdir(parents=True, exist_ok=True)
    (LOCKS / f"{language}.lock.json").write_text(
        json.dumps({"targetLanguage": language, "generatedAt": pack["version"],
                    "source": pack["sources"], "counts": report}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a Contexto pack from a Wiktextract extract.")
    parser.add_argument("--language", required=True, choices=sorted(LANGUAGES))
    parser.add_argument("--extract", type=Path, default=None)
    args = parser.parse_args()

    file_stem = LANGUAGES[args.language][0]
    extract_path = args.extract or (CACHE / f"{file_stem}.jsonl")
    if not extract_path.exists():
        sys.exit(f"extract not found: {extract_path}")

    pack = build(args.language, extract_path)
    report = write_pack(args.language, pack)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
