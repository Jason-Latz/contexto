#!/usr/bin/env python3
"""Flag suspect sourceGloss values for human review.

Three failure modes, all found in the 2026-07-14 triage of the legacy
(pre-pipeline, sourceIds=["curated-contexto"]) Spanish band:

  narrow-domain      A common English word glossed by ONE narrow, domain-marked
                     sense: version -> "software release", charge -> "formal
                     criminal accusation". The target is usually fine; the
                     definition shown on hover is misleading.
  templated          Boilerplate filler glosses ("a photographic image related
                     to X") left by the legacy seed generation.
  synthetic-compound Constructed two-word headwords ("team guide", "kitchen
                     photo") that are not real dictionary entries at all.

This is a LINT: it writes a review queue and changes nothing. Apply decisions
through the normal pipeline/analysis adjudication flow.

Usage:
  python3 scripts/lint_glosses.py                 # all four core packs
  python3 scripts/lint_glosses.py --language es   # one pack
  python3 scripts/lint_glosses.py --include-tail  # also lint *.tail.json
"""

import argparse
import json
import re
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent.parent / "public" / "language-packs"
OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "gloss-lint"
LANGUAGES = ["es", "de", "fr", "it"]

# Words this common are the ones users hover constantly; a narrow gloss there
# does real damage. Rarer words are far more likely to genuinely BE the
# domain-specific sense.
NARROW_DOMAIN_MIN_ZIPF = 4.0

# Domain-qualifier wordings that should not appear in the gloss of a common,
# polysemous English word. Deliberately over-broad: this feeds a human review
# queue, so a false positive costs a glance, while a miss ships bad teaching.
DOMAIN_MARKERS = [
    "software", "computing", "computer", "database", "programming",
    "criminal", "legal", "judicial", "law enforcement", "parliamentary",
    "scholarly", "academic", "scientific", "systematic study",
    "medical", "anatomical", "botanical", "biological", "chemical",
    "nautical", "naval", "military", "aviation",
    "political authority", "political", "governmental", "bureaucratic",
    "financial", "banking", "monetary", "accounting",
    "grammatical", "linguistic", "phonetic", "typographic",
    "musical notation", "astronomical", "geological", "architectural",
    "photographic", "ecclesiastical", "religious ceremony", "heraldic",
    "baseball", "cricket", "chess",
]
DOMAIN_RE = re.compile(r"\b(" + "|".join(re.escape(m) for m in DOMAIN_MARKERS) + r")\b", re.I)
TEMPLATED_RE = re.compile(r"\brelated to\b", re.I)


def flags_for(source: str, entry: dict) -> list:
    flags = []
    gloss = entry.get("sourceGloss") or ""
    zipf = entry.get("enZipf") or 0.0

    if TEMPLATED_RE.search(gloss):
        flags.append("templated")
    if " " in source.strip() and entry.get("partOfSpeech") != "expression":
        flags.append("synthetic-compound")
    if zipf >= NARROW_DOMAIN_MIN_ZIPF and DOMAIN_RE.search(gloss):
        flags.append("narrow-domain")
    return flags


def lint_pack(path: Path) -> list:
    pack = json.loads(path.read_text())
    rows = []
    for source, entry in pack["entries"].items():
        flags = flags_for(source, entry)
        if not flags:
            continue
        rows.append({
            "source": source,
            "target": entry.get("target"),
            "partOfSpeech": entry.get("partOfSpeech"),
            "sourceGloss": entry.get("sourceGloss"),
            "enZipf": entry.get("enZipf"),
            "eligible": entry.get("eligible", False),
            "confidence": entry.get("confidence"),
            "sourceIds": entry.get("sourceIds"),
            "flags": flags,
        })
    # Renderable words first, most-seen first: that is the review order.
    rows.sort(key=lambda r: (not r["eligible"], -(r["enZipf"] or 0.0)))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--language", choices=LANGUAGES, action="append",
                    help="lint only this pack (repeatable; default: all)")
    ap.add_argument("--include-tail", action="store_true",
                    help="also lint the quarantined *.tail.json shards")
    args = ap.parse_args()

    languages = args.language or LANGUAGES
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    table_lines = [
        "| pack | rows | narrow-domain | templated | synthetic-compound | eligible rows |",
        "|------|-----:|--------------:|----------:|-------------------:|--------------:|",
    ]
    preview_lines = []

    for lang in languages:
        shards = [PACK_DIR / f"{lang}.json"]
        if args.include_tail:
            shards.append(PACK_DIR / f"{lang}.tail.json")

        rows = []
        for shard in shards:
            if shard.exists():
                rows.extend(lint_pack(shard))

        out = OUT_DIR / f"{lang}-queue.jsonl"
        with out.open("w") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")

        counts = {f: sum(1 for r in rows if f in r["flags"])
                  for f in ("narrow-domain", "templated", "synthetic-compound")}
        eligible = sum(1 for r in rows if r["eligible"])
        table_lines.append(
            f"| {lang} | {len(rows)} | {counts['narrow-domain']} | {counts['templated']} "
            f"| {counts['synthetic-compound']} | {eligible} |")
        print(f"{lang}: {len(rows)} flagged ({eligible} renderable) -> {out}")

        preview = [r for r in rows if r["eligible"]][:15]
        if preview:
            preview_lines += ["", f"## {lang}: top renderable rows", ""]
            for r in preview:
                preview_lines.append(
                    f"- **{r['source']}** -> {r['target']} · \"{r['sourceGloss']}\" "
                    f"(zipf {r['enZipf']}, {', '.join(r['flags'])})")

    summary = [
        "# Gloss lint review queue",
        "",
        "Generated by `scripts/lint_glosses.py`. Nothing here was changed",
        "automatically; review and apply through the adjudication flow.",
        "",
        *table_lines,
        *preview_lines,
    ]
    (OUT_DIR / "SUMMARY.md").write_text("\n".join(summary) + "\n")
    print(f"summary -> {OUT_DIR / 'SUMMARY.md'}")


if __name__ == "__main__":
    main()
