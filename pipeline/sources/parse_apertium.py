#!/usr/bin/env python3
"""Parse Apertium bilingual dictionary (bidix) .dix files into flat jsonl.

Apertium bidix XML format (per pair, e.g. apertium-eng-spa.eng-spa.dix):

    <dictionary>
      <section id="main" type="standard">
        <e r="LR"><p><l>abrupt<s n="adj"/></l><r>repentino<s n="adj"/></r></p></e>
        ...
      </section>
      <section id="regexp" ...>   <!-- punctuation/regex rules, not real words -->
      <section id="final" ...>    <!-- ditto -->
    </dictionary>

Only `<section id="main">` holds real lexical entries; other sections (regexp,
regexp2, final) hold punctuation/regex rules with no literal word text and are
skipped. `<pardefs>` blocks (numeral/inflection paradigm fragments) are also
skipped — they define partial word continuations (e.g. bare "thousand" +
gender suffix), not standalone translation pairs.

The `r="LR"|"RL"` attribute on `<e>` restricts which *translation direction*
the Apertium engine uses an entry for (to disambiguate one-to-many mappings);
it does NOT mean the pairing itself is untrustworthy, so entries are kept
regardless of `r`.

Each pair's .dix file names its two sides `<lang1>-<lang2>.dix` with `<l>`
always = lang1, `<r>` always = lang2 — independent of which side is English.
`PAIRS` below records which literal side ('l' or 'r') is English for each
downloaded file.

Usage:
    python3 pipeline/sources/parse_apertium.py
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "pipeline" / "data" / "apertium-raw"
OUT_DIR = REPO_ROOT / "pipeline" / "data" / "sources"

# (dix filename, output lang code, which literal side is English, Apertium quality tier).
PAIRS = [
    ("apertium-eng-spa.eng-spa.dix", "es", "l", "trunk"),
    ("apertium-eng-deu.eng-deu.dix", "de", "l", "nursery"),
    ("apertium-eng-ita.eng-ita.dix", "it", "l", "incubator"),
    ("apertium-fra-eng.fra-eng.dix", "fr", "r", "incubator"),
]

# Apertium sdef POS tags -> normalized POS bucket. Anything not listed here is
# passed through as its raw Apertium tag (better than discarding it).
POS_MAP = {
    "n": "noun",
    "np": "noun",
    "adj": "adj",
    "adv": "adv",
    "preadv": "adv",
    "vblex": "verb",
    "vbser": "verb",
    "vbhaver": "verb",
    "vbmod": "verb",
    "prn": "pron",
    "det": "det",
    "predet": "det",
    "pr": "prep",
    "cnjcoo": "conj",
    "cnjsub": "conj",
    "cnjadv": "conj",
    "num": "num",
    "ij": "intj",
}

GENDER_MAP = {"m": "masculine", "f": "feminine", "nt": "neuter"}
# "mf" (common/epicene gender, one form for both) is deliberately excluded —
# it isn't one of masculine/feminine/neuter, so it maps to None.

# Grammatical placeholder lemmas used internally by Apertium (e.g. the
# generic personal-pronoun frame) — not real surface words.
PLACEHOLDER_LEMMAS = {"prpers"}

WHITESPACE_RE = re.compile(r"\s+")


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def extract_side(el: ET.Element) -> tuple[str | None, list[str]]:
    """Recursively extract literal text and <s> symbol tags from an <l>/<r> element.

    Returns (text, symbols). text is None if the element contains a <re>
    (regex) node — such entries carry no literal word text and are skipped.
    """
    if el is None:
        return None, []
    parts: list[str] = []
    symbols: list[str] = []

    def walk(node: ET.Element) -> bool:
        """Returns False if a <re> node was encountered (abort extraction)."""
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = local(child.tag)
            if tag == "b":
                parts.append(" ")
            elif tag == "s":
                symbols.append(child.get("n", ""))
            elif tag == "re":
                return False
            elif tag in ("g", "i"):
                if not walk(child):
                    return False
            # unknown tags (e.g. <a>) are ignored structurally
            if child.tail:
                parts.append(child.tail)
        return True

    if not walk(el):
        return None, symbols

    text = WHITESPACE_RE.sub(" ", "".join(parts)).strip()
    return text, symbols


def pos_and_gender(symbols: list[str]) -> tuple[str | None, str | None]:
    pos = None
    gender = None
    for i, sym in enumerate(symbols):
        if pos is None and i == 0:
            pos = POS_MAP.get(sym, sym) if sym else None
        if sym in GENDER_MAP:
            gender = GENDER_MAP[sym]
    return pos, gender


def parse_dix(path: Path, en_side: str) -> list[dict]:
    target_side = "r" if en_side == "l" else "l"
    tree = ET.parse(path)
    root = tree.getroot()

    rows: list[dict] = []
    seen: set[tuple] = set()
    dup_count = 0
    skipped_empty = 0
    skipped_placeholder = 0
    skipped_regex = 0
    skipped_identity = 0

    for section in root.iter("section"):
        if section.get("id") != "main":
            continue
        for e in section.findall("e"):
            p = e.find("p")
            if p is None:
                # Entries with no <p> instead wrap a single <i> (identity) form —
                # in practice these are 100% proper-noun/anthroponym entries
                # (personal names identical on both sides). No translation
                # teaching value and out of scope for a vocabulary bidix; skipped.
                if e.find("i") is not None:
                    skipped_identity += 1
                continue
            l_el = p.find("l")
            r_el = p.find("r")
            en_el = l_el if en_side == "l" else r_el
            tgt_el = r_el if en_side == "l" else l_el

            en_text, en_symbols = extract_side(en_el)
            tgt_text, tgt_symbols = extract_side(tgt_el)

            if en_text is None or tgt_text is None:
                skipped_regex += 1
                continue
            if not en_text or not tgt_text:
                skipped_empty += 1
                continue
            if en_text in PLACEHOLDER_LEMMAS or tgt_text in PLACEHOLDER_LEMMAS:
                skipped_placeholder += 1
                continue

            en_text = en_text.lower()
            pos, gender = pos_and_gender(tgt_symbols)
            if pos is None:
                # fall back to the English side's POS tag if the target side had none
                pos, _ = pos_and_gender(en_symbols)

            key = (en_text, tgt_text, pos, gender)
            if key in seen:
                dup_count += 1
                continue
            seen.add(key)

            rows.append({"en": en_text, "target": tgt_text, "pos": pos, "gender": gender})

    stats = {
        "rows": len(rows),
        "duplicates_dropped": dup_count,
        "skipped_empty": skipped_empty,
        "skipped_placeholder": skipped_placeholder,
        "skipped_regex_entries": skipped_regex,
        "skipped_identity_propernouns": skipped_identity,
    }
    return rows, stats


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    for filename, lang, en_side, tier in PAIRS:
        path = RAW_DIR / filename
        if not path.exists():
            print(f"SKIP {filename}: not found at {path}")
            continue
        rows, stats = parse_dix(path, en_side)
        out_path = OUT_DIR / f"apertium-eng-{lang}.jsonl"
        with out_path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{filename} [{tier}] -> {out_path.name}: {stats}")
        summary.append((lang, tier, stats))

    print("\n=== Summary ===")
    for lang, tier, stats in summary:
        print(f"  eng-{lang} ({tier}): {stats['rows']} rows")


if __name__ == "__main__":
    main()
