#!/usr/bin/env python3
"""Build the slim target-language Wiktextract cache for a language.

Streams the big kaikki target-language dump
(pipeline/data/wikt-cache/kaikki-<lang>.jsonl) once and writes a slim cache
pipeline/data/wikt-cache/slim-<lang>.jsonl of
    {lemma, pos, gender, plural, glosses[<=3]}
one record per noun/verb/adj/adv Wiktextract entry.

This is the SINGLE source of truth for slim-cache construction. It was factored
out of pipeline/analysis/merge_evidence.py (which builds slim-{de,fr,it} as a
side effect of the audit-side evidence merge) so that:
  - the exact same slim schema + morphology extraction is reused everywhere, and
  - a NEW language (es, whose Spanish target-language Wiktextract dump only
    became available 2026-07-15) can be built the same way, on demand, without
    duplicating the streaming/gloss logic.

Morphology (gender/plural) is taken from the already-tested extractors in
pipeline/import_wikt/extract.py so the slim cache stays consistent with how the
packs themselves were built.

Usage:
    python3 -m pipeline.analysis.build_slim_wikt es
    python3 -m pipeline.analysis.build_slim_wikt es de fr it
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WIKT_CACHE_DIR = REPO_ROOT / "pipeline" / "data" / "wikt-cache"

# Every language whose raw kaikki dump we know how to slim. de/fr/it have always
# been here; es was added once its Spanish Wiktextract dump landed (2026-07-15).
WIKT_DUMP_FILENAME = {
    "es": "kaikki-es.jsonl",
    "de": "kaikki-de.jsonl",
    "fr": "kaikki-fr.jsonl",
    "it": "kaikki-it.jsonl",
}

# Reuse the already-tested gender/plural extraction from the pack importer so the
# slim cache's morphology stays consistent with how the packs were built.
sys.path.insert(0, str(REPO_ROOT))
from pipeline.import_wikt.extract import _gender_of, _plural_of  # noqa: E402

POS_WANTED = {"noun", "verb", "adj", "adv"}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def slim_path(lang: str) -> Path:
    return WIKT_CACHE_DIR / f"slim-{lang}.jsonl"


def dump_path(lang: str) -> Path:
    return WIKT_CACHE_DIR / WIKT_DUMP_FILENAME[lang]


def dump_looks_complete(src_path: Path) -> bool:
    """Cheap completeness check for a possibly-still-downloading dump: the file
    exists, is non-trivially sized, and its LAST line parses as JSON (a partial
    download almost always leaves a truncated final line). Not a proof of
    completeness, but it stops us slimming an obviously half-written dump."""
    if not src_path.exists() or src_path.stat().st_size < 1_000_000:
        return False
    try:
        with open(src_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            back = min(size, 65536)
            f.seek(size - back)
            tail = f.read().splitlines()
        for raw in reversed(tail):
            raw = raw.strip()
            if raw:
                json.loads(raw)
                return True
    except (OSError, ValueError):
        return False
    return False


def build_slim_wikt_cache(lang: str, force: bool = False) -> Path:
    """Stream kaikki-<lang>.jsonl once -> slim-<lang>.jsonl. Skips the rebuild
    when the slim file is already newer than its source (unless force)."""
    if lang not in WIKT_DUMP_FILENAME:
        raise ValueError(f"no known kaikki dump filename for language {lang!r}")
    out_path = slim_path(lang)
    src_path = dump_path(lang)
    if not src_path.exists():
        raise FileNotFoundError(f"raw kaikki dump not found: {src_path}")
    if (not force and out_path.exists()
            and out_path.stat().st_mtime >= src_path.stat().st_mtime):
        log(f"slim wikt cache for {lang} already up to date: {out_path}")
        return out_path
    if not dump_looks_complete(src_path):
        raise ValueError(
            f"{src_path} does not look complete (missing / tiny / truncated last "
            f"line); refusing to build a partial slim cache")

    log(f"building slim wikt cache for {lang} from {src_path} ...")
    t0 = time.time()
    n_in = n_out = 0
    with open(src_path, encoding="utf-8") as fin, open(out_path, "w", encoding="utf-8") as fout:
        for line in fin:
            n_in += 1
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pos = rec.get("pos")
            if pos not in POS_WANTED:
                continue
            lemma = (rec.get("word") or "").strip()
            if not lemma:
                continue
            gender = plural = None
            if pos == "noun":
                gender = _gender_of(rec)
                plural = _plural_of(rec)
            glosses: list[str] = []
            for sense in rec.get("senses", []):
                if sense.get("form_of") or sense.get("alt_of"):
                    continue
                for g in sense.get("glosses") or []:
                    g = g.strip()
                    if g:
                        glosses.append(g)
                        break
                if len(glosses) >= 3:
                    break
            slim = {"lemma": lemma, "pos": pos, "gender": gender, "plural": plural, "glosses": glosses[:3]}
            fout.write(json.dumps(slim, ensure_ascii=False) + "\n")
            n_out += 1
    log(f"  {lang}: {n_in} lines in -> {n_out} slim records, {time.time() - t0:.1f}s -> {out_path}")
    return out_path


def main(argv=None) -> int:
    langs = list(argv if argv is not None else sys.argv[1:]) or sorted(WIKT_DUMP_FILENAME)
    for lang in langs:
        try:
            build_slim_wikt_cache(lang)
        except (FileNotFoundError, ValueError) as exc:
            log(f"  [skip] {lang}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
