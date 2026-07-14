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
    if zipf < _lint.NARROW_DOMAIN_MIN_ZIPF:
        return False
    # A domain marker that is the source word itself is self-reference, not a
    # domain qualifier: "judicial" -> "...the judicial branch of government"
    # is a fine gloss and reglossing it traded it for an 1881 Irish land-law
    # footnote (review finding).
    source = (entry.get("source") or "").lower()
    return any(m.group(0).lower() != source for m in _lint.DOMAIN_RE.finditer(gloss))

SENSE_CACHE = PROJECT_ROOT / "pipeline" / "data" / "en-sense-cache.jsonl"
LEFTOVER_QUEUE = PROJECT_ROOT / "docs" / "data-maintenance" / "2026-07-14-regloss-leftovers.jsonl"

# Gloss provenance marker appended to sourceIds when a sense-aligned gloss
# replaces the legacy one; also the idempotence marker for re-runs. Must NOT
# collide with a dictionary source id: 'kaikki-en' can already appear in
# sourceIds via corroboration (normalize.confidence_for extends sourceIds with
# enrichment sources), which would silently skip those entries (review finding).
GLOSS_SOURCE_ID = "regloss-sense-aligned"

GLOSS_SOURCE_META = {
    "name": "Sense-aligned gloss repair (English Wiktionary via kaikki.org)",
    "url": "https://kaikki.org/dictionary/rawdata.html",
    "license": "CC-BY-SA and GFDL",
    "notes": "sourceGloss replaced with the gloss of the Wiktionary sense whose "
             "translation table contains the entry's target (pipeline/import_es/"
             "regloss_legacy.py or an applied regloss verdict).",
}

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
    # long gloss instead of hard-truncating mid-sentence. A period inside an
    # abbreviation ("e.g. ", "i.e. ", "etc. ") is not a sentence boundary.
    if len(gloss) <= 120:
        return gloss
    for boundary in (". ", "; "):
        start = 40
        while (cut := gloss.find(boundary, start)) != -1:
            before = gloss[:cut].lower()
            if boundary == ". " and before.endswith(("e.g", "i.e", "etc", "cf", "vs")):
                start = cut + 1
                continue
            return gloss[:cut + (1 if boundary == ". " else 0)]
    return gloss


def fold(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold().strip()


def choose_aligned_gloss(senses: list[dict], target: str, g0: str = "") -> str | None:
    """Pick the gloss of the dominant sense aligned with `target`, or None.

    Senses are {'g': gloss, 'targets': set, 'n': full-table size}. Among the
    aligned senses with a usable gloss, the largest translation table wins
    (dominance proxy). Every refusal below routes the entry to the review
    queue instead of auto-applying — precision over recall, each guard earned
    by a shipped failure:

    - Gloss-less dominant block: Wiktextract often carries a word's MAIN
      translations in a word-level block with no gloss; a glossed sense with a
      much smaller table is a niche one ("death" -> the Grim Reaper).
    - Near-tie ambiguity: two glossed aligned senses with comparable tables
      ("keyboard" -> instrument vs computer) is a judgment call, not data.
    - Sole aligned sense: with nothing to compare against, dominance is
      unknowable from tables alone ("judicial" -> an 1881 Irish land-law
      clause was the ONLY aligned sense). Accept only when that sense IS the
      page's first sense (g0), Wiktionary's own dominance order.
    """
    aligned_all = [s for s in senses if target in s["targets"]]
    glossed = [s for s in aligned_all if usable_gloss(s["g"])]
    best = max(glossed, key=lambda s: s["n"], default=None)
    if best is None:
        return None
    if best["n"] * 2 < max(s["n"] for s in aligned_all):
        return None
    runners = [s for s in glossed if s is not best and s["g"] != best["g"]]
    if runners and max(s["n"] for s in runners) * 1.5 >= best["n"]:
        return None
    if len(aligned_all) == 1 and best["g"] != g0:
        return None
    return best["g"]


def load_sense_cache(language: str) -> dict[tuple[str, str], dict]:
    """(word, pos) -> {'senses': [...page order...], 'g0': first-sense gloss}.

    Each sense is {'g', 'targets', 'n'} where 'n' is the FULL de/fr/it/es
    translation-table size — the dominance proxy. A word's central senses carry
    rich translation tables; niche senses (heraldry, the Grim Reaper) carry a
    handful, so picking the aligned sense with the largest table avoids trading
    a narrow gloss for a different narrow gloss. 'g0' (the page's first sense)
    is the dominance signal of last resort for sole-aligned-sense words.
    """
    index: dict[tuple[str, str], dict] = {}
    with SENSE_CACHE.open("r", encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            key = (fold(row["w"]), row["pos"])
            slot = index.setdefault(key, {"senses": [], "g0": ""})
            if not slot["g0"] and row.get("g0"):
                slot["g0"] = row["g0"]
            for sense in row.get("senses", []):
                tr = sense.get("tr", [])
                targets = {fold(t[1]) for t in tr if t[0] == language}
                if targets:
                    slot["senses"].append(
                        {"g": sense.get("g", ""), "targets": targets, "n": len(tr)})
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
        slot = index.get((fold(key), pos), {"senses": [], "g0": ""})
        chosen = choose_aligned_gloss(slot["senses"], target, slot["g0"])
        if chosen is None:
            leftovers.append({
                "source": key,
                "target": entry.get("target"),
                "partOfSpeech": pos,
                "sourceGloss": entry.get("sourceGloss"),
                "enZipf": entry.get("enZipf"),
                "eligible": entry.get("eligible", False),
                "candidateGlosses": [s["g"] for s in slot["senses"] if usable_gloss(s["g"])][:3],
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

    if reglossed:
        pack.setdefault("sources", {}).setdefault(GLOSS_SOURCE_ID, dict(GLOSS_SOURCE_META))
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
