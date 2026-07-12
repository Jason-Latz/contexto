#!/usr/bin/env python3
"""Extract Wikidata Lexeme noun data (gender + plural) for de/fr/it/es.

Wikidata's Lexeme community is treated as an authority to cross-check /
correct the gender + plural fields produced by the Wiktextract-inverted
German/French/Italian packs (see Textum/CLAUDE.md "German pack quality").

Approach: stream the official Wikidata lexemes dump (one JSON array of all
Lexeme entities across all languages, gzip-compressed) rather than paging
SPARQL. SPARQL OFFSET pagination over query.wikidata.org degrades badly at
large offsets and lexeme queries with grammatical-feature joins are prone to
the service's 60s query timeout; a single sequential stream of the dump is
the more reliable option for a full extraction and is what this script does.

Resumability (two independent checkpoints):
  1. Download: delegated to `curl -C -` (byte-range resume), so a killed
     download just continues on next run.
  2. Processing: a JSON checkpoint file records how many top-level lexeme
     items have been consumed from the (single, sequential) ijson stream.
     On resume we re-open the dump and `itertools.islice` past that many
     items (cheap relative to re-downloading), then keep appending to the
     per-language JSONL outputs.

Usage:
  python3 fetch_wikidata_lexemes.py                 # download (if needed) + process
  python3 fetch_wikidata_lexemes.py --stage download # only fetch the dump
  python3 fetch_wikidata_lexemes.py --stage process  # only process (dump must exist)
  python3 fetch_wikidata_lexemes.py --reset          # wipe checkpoint + outputs, start over
  python3 fetch_wikidata_lexemes.py --limit 50000    # stop after N items (testing)

Resume command (if interrupted): re-run with no arguments from this same
directory; both the download and the item-processing checkpoint pick up
where they left off.
"""
from __future__ import annotations

import argparse
import gzip
import itertools
import json
import subprocess
import sys
import time
from pathlib import Path

try:
    import ijson
except ImportError:
    sys.exit(
        "Missing dependency 'ijson'. Install with:\n"
        "  pip3 install --user --break-system-packages ijson\n"
    )

DUMP_URL = "https://dumps.wikimedia.org/wikidatawiki/entities/latest-lexemes.json.gz"
USER_AGENT = (
    "ContextoLexemeFetcher/1.0 (contact: jasonlatz0@gmail.com; "
    "research pipeline for the Contexto browser extension)"
)

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE.parent / "data" / "sources"
DUMP_PATH = DATA_DIR / "wikidata-lexemes-dump.json.gz"
CHECKPOINT_PATH = DATA_DIR / ".wikidata_lexemes_checkpoint.json"

# Wikidata language QIDs -> our language codes.
LANGUAGE_QID_TO_CODE = {
    "Q188": "de",
    "Q150": "fr",
    "Q652": "it",
    "Q1321": "es",
}
LANGUAGES = tuple(LANGUAGE_QID_TO_CODE.values())

NOUN_CATEGORY_QID = "Q1084"  # wikibase-lexeme "noun" (shared across languages)

GENDER_QID_TO_LABEL = {
    "Q499327": "masculine",
    "Q1775415": "feminine",
    "Q1775461": "neuter",
    # Q1305037 "common gender" (Scandinavian-style) deliberately left unmapped:
    # our schema is masculine|feminine|neuter|null and this is genuinely none
    # of those.
}
GENDER_PROPERTY = "P5185"  # grammatical gender

PLURAL_FEATURE_QID = "Q146786"
NOMINATIVE_FEATURE_QID = "Q131105"

CHECKPOINT_SAVE_EVERY = 5000  # items
FLUSH_EVERY = 2000  # output lines


def log(msg: str) -> None:
    print(f"[fetch_wikidata_lexemes] {msg}", flush=True)


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text())
    return {
        "items_processed": 0,
        "counts": {lang: 0 for lang in LANGUAGES},
        "processing_complete": False,
    }


def save_checkpoint(cp: dict) -> None:
    cp["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = CHECKPOINT_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cp, indent=2))
    tmp.replace(CHECKPOINT_PATH)


def output_path(lang: str) -> Path:
    return DATA_DIR / f"wikidata-lexemes-{lang}.jsonl"


def reset_state() -> None:
    log("--reset: wiping checkpoint + per-language outputs (dump file kept)")
    if CHECKPOINT_PATH.exists():
        CHECKPOINT_PATH.unlink()
    for lang in LANGUAGES:
        p = output_path(lang)
        if p.exists():
            p.unlink()


def stage_download() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if DUMP_PATH.exists():
        size = DUMP_PATH.stat().st_size
        log(f"dump already present ({size:,} bytes so far) - resuming via curl -C -")
    else:
        log("starting fresh dump download")

    # curl -C - resumes from the existing file's byte length automatically
    # (byte-range request), and retries on transient network errors.
    cmd = [
        "curl",
        "-sS",
        "-C",
        "-",
        "--retry",
        "8",
        "--retry-delay",
        "5",
        "--retry-connrefused",
        "-H",
        f"User-Agent: {USER_AGENT}",
        "-o",
        str(DUMP_PATH),
        DUMP_URL,
    ]
    log(f"running: {' '.join(cmd)}")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        log(f"curl exited with code {result.returncode} (may be a partial download; "
            "re-run to resume)")
        sys.exit(result.returncode)
    log(f"download complete: {DUMP_PATH.stat().st_size:,} bytes")


def extract_gender(claims: dict) -> str | None:
    for stmt in claims.get(GENDER_PROPERTY, []):
        try:
            qid = stmt["mainsnak"]["datavalue"]["value"]["id"]
        except (KeyError, TypeError):
            continue
        label = GENDER_QID_TO_LABEL.get(qid)
        if label:
            return label
    return None


def extract_plural(forms: list, lang: str) -> str | None:
    """Prefer a nominative-plural form (matters for German's case system);
    fall back to the first form tagged plural (French/Italian/Spanish nouns
    generally have no case forms, just singular/plural)."""
    plain_plural = None
    for form in forms:
        features = set(form.get("grammaticalFeatures", []))
        if PLURAL_FEATURE_QID not in features:
            continue
        rep = form.get("representations", {}).get(lang, {}).get("value")
        if not rep:
            continue
        if NOMINATIVE_FEATURE_QID in features:
            return rep  # best match, stop immediately
        if plain_plural is None:
            plain_plural = rep
    return plain_plural


def stage_process(limit: int | None) -> None:
    if not DUMP_PATH.exists():
        sys.exit(f"Dump not found at {DUMP_PATH}; run --stage download first.")

    cp = load_checkpoint()
    skip = cp["items_processed"]
    mode = "a" if skip > 0 else "w"
    if skip > 0:
        log(f"resuming: skipping first {skip:,} already-processed items")
    else:
        log("fresh processing run")

    outputs = {lang: open(output_path(lang), mode, encoding="utf-8") for lang in LANGUAGES}
    lines_since_flush = 0
    processed_this_run = 0
    start = time.time()
    idx = skip

    try:
        with gzip.open(DUMP_PATH, "rb") as fh:
            parser = ijson.items(fh, "item")
            if skip:
                parser = itertools.islice(parser, skip, None)
            for lexeme in parser:
                idx += 1
                processed_this_run += 1

                if limit is not None and processed_this_run > limit:
                    idx -= 1
                    processed_this_run -= 1
                    break

                lang_qid = lexeme.get("language")
                lang = LANGUAGE_QID_TO_CODE.get(lang_qid)
                if lang and lexeme.get("lexicalCategory") == NOUN_CATEGORY_QID:
                    lemma = (
                        lexeme.get("lemmas", {}).get(lang, {}).get("value")
                    )
                    if lemma:
                        gender = extract_gender(lexeme.get("claims", {}))
                        plural = extract_plural(lexeme.get("forms", []), lang)
                        row = {
                            "lemma": lemma,
                            "gender": gender,
                            "plural": plural,
                            "lexemeId": lexeme.get("id"),
                        }
                        outputs[lang].write(json.dumps(row, ensure_ascii=False) + "\n")
                        cp["counts"][lang] += 1
                        lines_since_flush += 1

                if idx % CHECKPOINT_SAVE_EVERY == 0:
                    cp["items_processed"] = idx
                    save_checkpoint(cp)
                if lines_since_flush >= FLUSH_EVERY:
                    for f in outputs.values():
                        f.flush()
                    lines_since_flush = 0
                if idx % 100000 == 0:
                    elapsed = time.time() - start
                    rate = processed_this_run / elapsed if elapsed else 0
                    log(
                        f"{idx:,} lexemes scanned "
                        f"({processed_this_run:,} this run, {rate:.0f}/s) - "
                        f"counts so far: {cp['counts']}"
                    )
            else:
                # loop completed without break => reached end of dump
                cp["processing_complete"] = True
    finally:
        cp["items_processed"] = idx
        save_checkpoint(cp)
        for f in outputs.values():
            f.flush()
            f.close()

    elapsed = time.time() - start
    log(f"processed {processed_this_run:,} items this run in {elapsed:.1f}s")
    log(f"totals so far: {cp['counts']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stage", choices=["download", "process", "all"], default="all")
    ap.add_argument("--reset", action="store_true", help="wipe checkpoint + outputs first")
    ap.add_argument("--limit", type=int, default=None, help="stop after N items this run (testing)")
    args = ap.parse_args()

    if args.reset:
        reset_state()

    if args.stage in ("download", "all"):
        stage_download()
    if args.stage in ("process", "all"):
        stage_process(args.limit)


if __name__ == "__main__":
    main()
