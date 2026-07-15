#!/usr/bin/env python3
"""Extract en->target Wikipedia interlanguage-link title pairs for es/de/fr/it
from the enwiki `langlinks` + `page` SQL dumps, for the long-tail vocabulary
candidate universe (see Textum/CLAUDE.md "Vocabulary tiers"). A pair like
en "microprocessor" -> de "Mikroprozessor" is a *candidate*: precision of the
PAIRING is what this script optimizes for, frequency/dictionary filtering of
individual words happens downstream (pipeline/import_tail, build_universe.py).

Dump format: WMF SQL dumps are standard `mysqldump` extended-INSERT text,
gzip-compressed, one INSERT statement per physical line (titles never contain
raw newlines), with C-style backslash escaping inside single-quoted strings
(\\' \\" \\\\ \\n ...). Splitting naively on commas would corrupt any title
containing an escaped quote or a literal comma/paren, so tuples are tokenized
respecting quote state (see `iter_insert_tuples`).

  langlinks (ll_from INT, ll_lang STRING, ll_title STRING):
    ll_from is the English (enwiki) page_id; ll_lang/ll_title are the target
    wiki's language code and article title.
  page (page_id INT, page_namespace INT, page_title STRING, ...):
    resolves an enwiki page_id to its title. Only page_namespace=0 (article
    space) is in scope.

Two-pass, bounded memory: pass 1 streams langlinks and keeps only rows whose
ll_lang is one of the four target languages, as per-language dict[page_id ->
target_title] (a few million small string entries total — comfortably fits in
memory; sqlite3-on-disk was considered but proved unnecessary at this scale).
Pass 2 streams the (much larger) page dump and resolves page_id -> English
title ONLY for the ids seen in pass 1, discarding everything else on the fly
so the resolved map never exceeds the pass-1 id set.

Filters (see module docstring sections below for exact rules): English side
must be a single bare word of letters (+ internal hyphen), length 3-40, no
disambiguation parenthetical or :/# meta-title markers. Target side must be a
single word of letters (+ internal hyphen/apostrophe, for fr/it elision), no
parentheticals. Cognates (target == en title, case-insensitively) are KEPT
and counted, not dropped — cognate handling is a downstream concern.

Usage:
  python3 pipeline/sources/parse_wikipedia_langlinks.py \\
      --langlinks pipeline/data/wikipedia/enwiki-latest-langlinks.sql.gz \\
      --page pipeline/data/wikipedia/enwiki-latest-page.sql.gz \\
      --out-dir pipeline/data/wikipedia \\
      --languages es,de,fr,it
"""
from __future__ import annotations

import argparse
import gzip
import re
import sys
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LANGLINKS = REPO_ROOT / "pipeline" / "data" / "wikipedia" / "enwiki-latest-langlinks.sql.gz"
DEFAULT_PAGE = REPO_ROOT / "pipeline" / "data" / "wikipedia" / "enwiki-latest-page.sql.gz"
DEFAULT_OUT_DIR = REPO_ROOT / "pipeline" / "data" / "wikipedia"

TARGET_LANGS = ("es", "de", "fr", "it")
PROGRESS_EVERY = 5_000_000

# --- MySQL dump tokenizing --------------------------------------------------
#
# Matches one whole top-level `(...)` VALUES tuple per regex match. Inside a
# tuple, content is either a complete single-quoted string (escapes `\\.`
# consumed as a unit, so an escaped quote can never close the string early)
# or a run of non-paren/non-quote chars (digits, commas, NULL, decimal
# points...). This is exact — not a heuristic — because VALUES tuples hold
# only scalar columns, so parens never nest at the SQL level; any '(' or ')'
# inside a quoted title (e.g. "Boston (band)") is consumed by the string
# alternative and can't be mistaken for a tuple boundary. One regex match
# per tuple (instead of a Python-level loop per token) is what makes this
# fast enough for the multi-GB decompressed `page` dump.
_TUPLE_RE = re.compile(r"\((?:'(?:\\.|[^'\\])*'|[^()'])*\)")

_MYSQL_ESCAPES = {
    "0": "\0", "'": "'", '"': '"', "b": "\b", "n": "\n",
    "r": "\r", "t": "\t", "Z": "\x1a", "\\": "\\", "%": "%", "_": "_",
}


def _mysql_unescape(raw: str) -> str:
    if "\\" not in raw:
        return raw
    out = []
    i, n = 0, len(raw)
    while i < n:
        c = raw[i]
        if c == "\\" and i + 1 < n:
            out.append(_MYSQL_ESCAPES.get(raw[i + 1], raw[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def iter_insert_tuples(line: str):
    """Yield each top-level `(...)` tuple's inner text from one INSERT line."""
    idx = line.find("VALUES (")
    if idx == -1:
        return
    values_part = line[idx + len("VALUES ") :]
    for m in _TUPLE_RE.finditer(values_part):
        yield m.group()[1:-1]


# Fixed 3-column schema (ll_from, ll_lang, ll_title) - all NOT NULL, so a
# full-match regex on the tuple's inner text is safe and simplest.
_LANGLINKS_ROW_RE = re.compile(r"^(\d+),'((?:\\.|[^'\\])*)','((?:\\.|[^'\\])*)'$")

# page has ~12 columns; we only need the first 3 (id, namespace, title), so
# match just that prefix and ignore however the rest of the tuple is shaped.
_PAGE_ROW_PREFIX_RE = re.compile(r"^(\d+),(\d+),'((?:\\.|[^'\\])*)'")


# --- Filters -----------------------------------------------------------------

_EN_TITLE_RE = re.compile(r"^[A-Za-z]+(?:-[A-Za-z]+)*$")
# Unicode letters (accented/German/etc.) + internal hyphen or apostrophe
# (fr/it elision, e.g. "aujourd'hui"). `[^\W\d_]` = "word char, not digit/_".
_TARGET_TITLE_RE = re.compile(r"^[^\W\d_]+(?:[-'][^\W\d_]+)*$")
_EN_SPECIAL_CHARS = set("():/#")


def classify_en_title(raw_title: str) -> tuple[str | None, str]:
    """Return (lowercased key, reason). key is None if the row is rejected."""
    if any(ch in _EN_SPECIAL_CHARS for ch in raw_title):
        return None, "en_disambig_or_special"
    if "_" in raw_title:
        return None, "en_multiword"
    if not (3 <= len(raw_title) <= 40):
        return None, "en_bad_length"
    if not _EN_TITLE_RE.match(raw_title):
        return None, "en_nonletter"
    return raw_title.lower(), "ok"


def classify_target_title(raw_title: str) -> tuple[str | None, str]:
    if "(" in raw_title or ")" in raw_title:
        return None, "target_parenthetical"
    if "_" in raw_title:
        return None, "target_multiword"
    if not _TARGET_TITLE_RE.match(raw_title):
        return None, "target_nonletter"
    return raw_title, "ok"


# --- Pass 1: langlinks -------------------------------------------------------


def open_dump(path: Path):
    return gzip.open(path, "rt", encoding="utf-8", errors="replace")


def parse_langlinks(path: Path, target_langs: tuple[str, ...]):
    lang_targets: dict[str, dict[int, str]] = {lang: {} for lang in target_langs}
    stats: Counter = Counter()
    row_count = 0
    t0 = time.time()
    with open_dump(path) as f:
        for line in f:
            if not line.startswith("INSERT INTO"):
                continue
            for inner in iter_insert_tuples(line):
                m = _LANGLINKS_ROW_RE.match(inner)
                if not m:
                    stats["langlinks_parse_error"] += 1
                    continue
                row_count += 1
                if row_count % PROGRESS_EVERY == 0:
                    print(f"[langlinks] {row_count:,} rows scanned ({time.time() - t0:.0f}s)...", file=sys.stderr)

                lang = _mysql_unescape(m.group(2))
                bucket = lang_targets.get(lang)
                if bucket is None:
                    continue

                raw_title = _mysql_unescape(m.group(3))
                target, reason = classify_target_title(raw_title)
                if target is None:
                    stats[reason] += 1
                    continue

                page_id = int(m.group(1))
                if page_id in bucket:
                    stats[f"{lang}_langlinks_dup_ll_from"] += 1
                    continue
                bucket[page_id] = target
    print(f"[langlinks] done: {row_count:,} rows scanned in {time.time() - t0:.0f}s", file=sys.stderr)
    return lang_targets, stats


# --- Pass 2: page ------------------------------------------------------------


def parse_page_titles(path: Path, needed_ids: set[int]):
    id_to_en: dict[int, str] = {}
    stats: Counter = Counter()
    row_count = 0
    t0 = time.time()
    with open_dump(path) as f:
        for line in f:
            if not line.startswith("INSERT INTO"):
                continue
            for inner in iter_insert_tuples(line):
                m = _PAGE_ROW_PREFIX_RE.match(inner)
                if not m:
                    stats["page_parse_error"] += 1
                    continue
                row_count += 1
                if row_count % PROGRESS_EVERY == 0:
                    print(
                        f"[page] {row_count:,} rows scanned ({time.time() - t0:.0f}s), "
                        f"{len(id_to_en):,} resolved...",
                        file=sys.stderr,
                    )

                page_id = int(m.group(1))
                if page_id not in needed_ids:
                    continue
                namespace = int(m.group(2))
                if namespace != 0:
                    stats["en_wrong_namespace"] += 1
                    continue

                raw_title = _mysql_unescape(m.group(3))
                en_key, reason = classify_en_title(raw_title)
                if en_key is None:
                    stats[reason] += 1
                    continue
                id_to_en[page_id] = en_key
    print(
        f"[page] done: {row_count:,} rows scanned in {time.time() - t0:.0f}s, {len(id_to_en):,} resolved",
        file=sys.stderr,
    )
    return id_to_en, stats


# --- Merge + write -----------------------------------------------------------


def build_output(lang_bucket: dict[int, str], id_to_en: dict[int, str]):
    output: dict[str, str] = {}
    conflicts = 0
    cognates = 0
    unresolved = 0
    for page_id, target in lang_bucket.items():
        en_key = id_to_en.get(page_id)
        if en_key is None:
            unresolved += 1
            continue
        existing = output.get(en_key)
        if existing is not None:
            if existing != target:
                conflicts += 1
            continue
        output[en_key] = target
        if target.lower() == en_key.lower():
            cognates += 1
    return output, {"conflicts": conflicts, "cognates": cognates, "unresolved_en_id": unresolved}


def write_tsv(output: dict[str, str], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for en_key in sorted(output):
            f.write(f"{en_key}\t{output[en_key]}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--langlinks", type=Path, default=DEFAULT_LANGLINKS, help="Path to enwiki-latest-langlinks.sql.gz")
    parser.add_argument("--page", type=Path, default=DEFAULT_PAGE, help="Path to enwiki-latest-page.sql.gz")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="Output directory for langlinks-<lang>.tsv")
    parser.add_argument("--languages", default=",".join(TARGET_LANGS), help="Comma-separated target language codes")
    args = parser.parse_args()

    langs = tuple(args.languages.split(","))

    print(f"Pass 1/2: scanning {args.langlinks} for langs {langs}...")
    lang_targets, ll_stats = parse_langlinks(args.langlinks, langs)
    for lang in langs:
        print(f"  {lang}: {len(lang_targets[lang]):,} candidate rows after target-title filter")

    needed_ids: set[int] = set()
    for lang in langs:
        needed_ids.update(lang_targets[lang].keys())
    print(f"Pass 2/2: scanning {args.page} to resolve {len(needed_ids):,} English page ids...")
    id_to_en, page_stats = parse_page_titles(args.page, needed_ids)

    drop_counts: Counter = Counter()
    drop_counts.update(ll_stats)
    drop_counts.update(page_stats)

    summary = {}
    for lang in langs:
        output, extra = build_output(lang_targets[lang], id_to_en)
        out_path = args.out_dir / f"langlinks-{lang}.tsv"
        write_tsv(output, out_path)
        summary[lang] = {"lines": len(output), **extra}
        print(f"[{lang}] wrote {len(output):,} pairs -> {out_path}")

    print("\n=== Drop reasons ===")
    for reason, count in sorted(drop_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {reason}: {count:,}")

    print("\n=== Per-language summary ===")
    for lang, s in summary.items():
        print(f"  {lang}: {s}")


if __name__ == "__main__":
    main()
