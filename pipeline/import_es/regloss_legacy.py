"""Sense-aligned regloss of the SUSPECT legacy curated Spanish glosses.

The pre-pipeline seed generation gave many entries a narrow single-sense gloss
(version -> "software release") even when the target teaches the dominant sense.
This repairs them with provenance instead of guesswork: for each suspect legacy
entry (source, partOfSpeech, target), find the English Wiktionary SENSE of the
source word whose own Spanish translation table contains the entry's target.
That sense's gloss then describes exactly the pairing the entry teaches — the
gloss-is-the-contract policy, enforced by data rather than by an LLM.

Only SUSPECT glosses are replaced (the same signals scripts/lint_glosses.py
flags: domain-marked wording on a common word, or the templated "related to X"
boilerplate). Wiktionary's per-sense translation tables are sparse, so the
aligned sense is not always the best-worded one; a serviceable legacy gloss
("image" -> "visual picture") must not be traded for a worse aligned sense.

Needs the sense-level cache built by scripts/stream_en_sense_translations.py:

    curl -s https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl \
        | python3 scripts/stream_en_sense_translations.py pipeline/data/en-sense-cache.jsonl

Entries with no aligned sense are left untouched and written to a leftover
queue for the adjudication engine's regloss verdict (pipeline/analysis).

Run:  python3 -m pipeline.import_es.regloss_legacy
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

from .build import CURATED_SOURCE_ID, DEFAULT_PACK, read_json, write_json
from .normalize import clean_gloss

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Shared suspect-gloss signals from the lint (imported from the script itself
# so the two can never drift apart).
import importlib.util as _ilu

_lint_spec = _ilu.spec_from_file_location(
    "lint_glosses", PROJECT_ROOT / "scripts" / "lint_glosses.py")
_lint = _ilu.module_from_spec(_lint_spec)
_lint_spec.loader.exec_module(_lint)


def is_suspect(entry: dict) -> bool:
    gloss = entry.get("sourceGloss") or ""
    zipf = entry.get("enZipf") or 0.0
    if _lint.TEMPLATED_RE.search(gloss):
        return True
    return zipf >= _lint.NARROW_DOMAIN_MIN_ZIPF and bool(_lint.DOMAIN_RE.search(gloss))

SENSE_CACHE = PROJECT_ROOT / "pipeline" / "data" / "en-sense-cache.jsonl"
LEFTOVER_QUEUE = PROJECT_ROOT / "docs" / "data-maintenance" / "2026-07-14-regloss-leftovers.jsonl"

# Gloss provenance marker appended to sourceIds when a sense-aligned gloss
# replaces the legacy one. 'curated-contexto' is kept: the PAIR is still the
# curated one; only the gloss gained a source.
GLOSS_SOURCE_ID = "kaikki-en"

CONTENT_POS = {"noun", "verb", "adjective", "adverb"}

# Wiktionary meta-glosses define a FORM, not a meaning ("Ellipsis of mobile
# data", "Alternative spelling of ..."); they can carry translation tables and
# would otherwise win alignment while teaching nothing.
META_GLOSS_RE = re.compile(
    r"^(ellipsis|abbreviation|initialism|acronym|alternative (form|spelling|letter-case)"
    r"|synonym of|clipping|short for|obsolete (form|spelling)|archaic (form|spelling)"
    r"|misspelling|plural of|diminutive of|augmentative of|inflection of|dated (form|spelling))\b",
    re.I,
)


DANGLING_LAST_WORDS = {"particularly", "especially", "including", "notably", "such"}


def usable_gloss(gloss: str) -> bool:
    # One-word glosses ("Direction.") add nothing on a polysemous word; a gloss
    # ending in ":" or a qualifier is a truncated list intro ("A rule, such
    # as:", "Any protracted conflict, particularly").
    if not gloss or META_GLOSS_RE.match(gloss) or len(gloss.split()) < 2:
        return False
    stripped = gloss.rstrip().rstrip(".,;")
    last = stripped.split()[-1].lower() if stripped.split() else ""
    return not gloss.rstrip().endswith(":") and last not in DANGLING_LAST_WORDS


def first_clause(gloss: str) -> str:
    # A hover card is not a dictionary page: keep the first full clause of a
    # long gloss instead of hard-truncating mid-sentence.
    if len(gloss) <= 120:
        return gloss
    for boundary in (". ", "; "):
        cut = gloss.find(boundary, 40)
        if cut != -1:
            return gloss[:cut + (1 if boundary == ". " else 0)]
    return gloss


def fold(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold().strip()


def choose_aligned_gloss(senses: list[dict], target: str) -> str | None:
    """Pick the gloss of the dominant sense aligned with `target`, or None.

    Senses are {'g': gloss, 'targets': set, 'n': full-table size}. Among the
    aligned senses with a usable gloss, the largest translation table wins
    (dominance proxy). Wiktextract often carries a word's MAIN translations in
    a gloss-less word-level block; if the best glossed sense's table is much
    smaller than the largest aligned table, the glossed sense is a niche one
    ("death" -> the Grim Reaper) — return None and let a human decide.
    """
    aligned_all = [s for s in senses if target in s["targets"]]
    glossed = [s for s in aligned_all if usable_gloss(s["g"])]
    best = max(glossed, key=lambda s: s["n"], default=None)
    if best is None:
        return None
    if best["n"] * 2 < max(s["n"] for s in aligned_all):
        return None
    return best["g"]


def load_sense_cache(language: str) -> dict[tuple[str, str], list[dict]]:
    """(word, pos) -> senses in page order, each {'g', 'targets', 'n'}.

    'n' is the FULL de/fr/it/es translation-table size of the sense — the
    dominance proxy. A word's central senses carry rich translation tables;
    niche senses (heraldry, the Grim Reaper) carry a handful, so picking the
    aligned sense with the largest table avoids trading a narrow gloss for a
    different narrow gloss.
    """
    index: dict[tuple[str, str], list[dict]] = {}
    with SENSE_CACHE.open("r", encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            key = (fold(row["w"]), row["pos"])
            senses = index.setdefault(key, [])
            for sense in row.get("senses", []):
                tr = sense.get("tr", [])
                targets = {fold(t[1]) for t in tr if t[0] == language}
                if targets:
                    senses.append({"g": sense.get("g", ""), "targets": targets, "n": len(tr)})
    return index


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, default=DEFAULT_PACK)
    parser.add_argument("--language", default="es")
    args = parser.parse_args()

    if not SENSE_CACHE.exists():
        raise SystemExit(f"{SENSE_CACHE} missing — build it first (see module docstring)")

    index = load_sense_cache(args.language)
    pack = read_json(args.pack)

    reglossed = 0
    unchanged_aligned = 0
    not_suspect = 0
    leftovers = []
    samples = []

    # Suspect glosses are repaired regardless of origin: the legacy curated
    # block is the worst offender, but FreeDict first-definition glosses have
    # the same failure mode ("death" -> "Execution (in the judicial sense)").
    # In-place freedict fixes follow the same precedent as the applied audit
    # fixes: a full re-import regenerates them, so re-imports must re-run this.
    for key, entry in pack["entries"].items():
        if GLOSS_SOURCE_ID in entry.get("sourceIds", []):
            continue  # already reglossed on a previous run
        pos = entry.get("partOfSpeech")
        if pos not in CONTENT_POS or " " in key:
            continue
        if not is_suspect(entry):
            not_suspect += 1
            continue

        target = fold(entry.get("target", ""))
        senses = index.get((fold(key), pos), [])
        chosen = choose_aligned_gloss(senses, target)
        if chosen is None:
            leftovers.append({
                "source": key,
                "target": entry.get("target"),
                "partOfSpeech": pos,
                "sourceGloss": entry.get("sourceGloss"),
                "enZipf": entry.get("enZipf"),
                "eligible": entry.get("eligible", False),
                "candidateGlosses": [s["g"] for s in senses if usable_gloss(s["g"])][:3],
            })
            continue

        new_gloss = clean_gloss(first_clause(chosen))
        if not new_gloss:
            continue
        if new_gloss == entry.get("sourceGloss"):
            unchanged_aligned += 1
            continue

        if len(samples) < 12:
            samples.append(f"{key} -> {entry.get('target')}: "
                           f"{json.dumps(entry.get('sourceGloss'))} => {json.dumps(new_gloss)}")
        entry["sourceGloss"] = new_gloss
        entry["sourceIds"] = [*entry["sourceIds"], GLOSS_SOURCE_ID]
        reglossed += 1

    write_json(args.pack, pack)

    LEFTOVER_QUEUE.parent.mkdir(parents=True, exist_ok=True)
    with LEFTOVER_QUEUE.open("w", encoding="utf-8") as fh:
        for row in sorted(leftovers, key=lambda r: -(r.get("enZipf") or 0)):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({
        "reglossed": reglossed,
        "alreadyIdentical": unchanged_aligned,
        "keptNotSuspect": not_suspect,
        "suspectButNoAlignedSense": len(leftovers),
        "leftoverQueue": str(LEFTOVER_QUEUE.relative_to(PROJECT_ROOT)),
    }, indent=2))
    print("\n".join(samples))


if __name__ == "__main__":
    main()
