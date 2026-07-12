#!/usr/bin/env python3
"""Convert a FreeDict eng-<lang> TEI source file into normalized JSONL.

Handles the three TEI dialects observed across the FreeDict eng-deu,
eng-fra, and eng-ita releases (see Textum/CLAUDE.md "Multi-language"):

  - eng-deu (Ding-derived): entry-level `<gramGrp><pos>` for the headword,
    plus PER-TRANSLATION `<gramGrp>` nested inside each `<cit type="trans">`
    carrying `<pos>`/`<gen>`/`<number>` for that specific target word. Nouns
    are tagged only with `<gen>` (no explicit `n` pos value anywhere in the
    file) - gender presence implies noun.
  - eng-fra (small/sparse): almost no `<gramGrp>` or `<def>` at all (one
    `<pos>` tag in the whole 8.8k-entry file). Most rows come out
    `pos: "unknown"`, `gender: null`, `notes: null`.
  - eng-ita (WikDict-derived): entry-level `<gramGrp><pos>`, multiple
    `<quote>` per `<cit type="trans">`, and the definition for a translation
    group sits in a NESTED `<sense><def>` one level below the sense that
    holds the `<cit>`. No gender/number markup.

None of the three TEI dialects give an explicit inflected plural form (only
a `<number>pl</number>` tag marking that a *given* translation quote already
*is* a plural form) - `plural` is therefore always emitted as null here;
gender/plural enrichment for de/fr/it is expected to come from a downstream
source (as it already does for the Wiktextract-inverted core packs).

Usage:
  python3 parse_freedict_eng.py --tei <path/to/eng-xxx.tei> --language de --out <path/to/out.jsonl>
"""
from __future__ import annotations

import argparse
import json
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


def q(tag: str) -> str:
    """Qualify a bare TEI tag name with its namespace, for iterparse tag checks."""
    return f"{{{TEI_NS['tei']}}}{tag}"


# POS values seen across the three dialects, folded onto the shared taxonomy.
# Short Ding-style abbreviations (eng-deu) and long WikDict-style names
# (eng-ita) are both mapped; French supplies almost no POS data at all.
POS_MAP: dict[str, str] = {
    "n": "noun",
    "pn": "noun",
    "noun": "noun",
    "v": "verb",
    "verb": "verb",
    "adj": "adjective",
    "adjective": "adjective",
    "adv": "adverb",
    "adverb": "adverb",
    "phraseologicalUnit": "expression",
    "proverb": "expression",
    "prep": "function",
    "preposition": "function",
    "int": "function",
    "interjection": "function",
    "pron": "function",
    "pronoun": "function",
    "num": "function",
    "numeral": "function",
    "conj": "function",
    "conjunction": "function",
    "art": "function",
    "article": "function",
    "ptcl": "function",
    "particle": "function",
    "determiner": "function",
    "postposition": "function",
    # Affixes and symbols don't map onto a standalone word class we track.
    "prefix": "unknown",
    "suffix": "unknown",
    "symbol": "unknown",
}

GENDER_MAP: dict[str, str] = {
    "masc": "masculine",
    "masculine": "masculine",
    "m": "masculine",
    "fem": "feminine",
    "feminine": "feminine",
    "f": "feminine",
    "neut": "neuter",
    "neuter": "neuter",
}


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(unescape(value.replace("\xa0", " ")).split())


def element_text(element: ElementTree.Element) -> str:
    return clean_text("".join(element.itertext()))


def map_pos(raw_pos: str | None, *, has_gender: bool) -> str:
    if raw_pos:
        mapped = POS_MAP.get(raw_pos)
        if mapped is not None:
            return mapped
    if has_gender:
        # eng-deu tags nouns with only <gen>, never an explicit "n" pos.
        return "noun"
    return "unknown"


def map_gender(raw_gender: str | None) -> str | None:
    if not raw_gender:
        return None
    return GENDER_MAP.get(raw_gender)


def def_text_for_sense(sense: ElementTree.Element) -> str | None:
    """Find the definition/gloss text belonging to a <sense>.

    eng-ita nests the definition one level below the sense that holds the
    <cit type="trans">: <sense><cit .../><sense><def>...</def></sense></sense>.
    Direct-child <def> is also checked in case a dialect puts it alongside
    the <cit> instead.
    """
    direct = sense.find("tei:def", TEI_NS)
    if direct is not None:
        text = element_text(direct)
        if text:
            return text

    nested = sense.find("tei:sense/tei:def", TEI_NS)
    if nested is not None:
        text = element_text(nested)
        if text:
            return text

    return None


def iter_rows_for_entry(entry: ElementTree.Element):
    source_raw = entry.findtext("tei:form/tei:orth", namespaces=TEI_NS)
    source = clean_text(source_raw).lower()
    if not source:
        return

    entry_pos_raw = clean_text(entry.findtext("tei:gramGrp/tei:pos", namespaces=TEI_NS)) or None

    for sense in entry.findall("tei:sense", TEI_NS):
        gloss = def_text_for_sense(sense)

        for cit in sense.findall('tei:cit[@type="trans"]', TEI_NS):
            cit_pos_raw = clean_text(cit.findtext("tei:gramGrp/tei:pos", namespaces=TEI_NS)) or None
            cit_gender_raw = clean_text(cit.findtext("tei:gramGrp/tei:gen", namespaces=TEI_NS)) or None

            part_of_speech = map_pos(cit_pos_raw or entry_pos_raw, has_gender=bool(cit_gender_raw))
            gender = map_gender(cit_gender_raw) if part_of_speech == "noun" else None

            for quote in cit.findall("tei:quote", TEI_NS):
                target = element_text(quote)
                if not target:
                    continue

                pos = part_of_speech
                if pos != "function" and " " in source:
                    pos = "expression"

                yield {
                    "en": source,
                    "target": target,
                    "pos": pos,
                    "gender": gender if pos == "noun" else None,
                    "plural": None,
                    "notes": gloss,
                }


def parse_tei(tei_path: Path):
    """Stream-parse the TEI file, yielding normalized rows in source order.

    Uses iterparse + per-entry clear() rather than a full DOM parse because
    the eng-deu release is ~360MB of XML (460k entries).
    """
    context = ElementTree.iterparse(str(tei_path), events=("end",))
    for _event, elem in context:
        if elem.tag != q("entry"):
            continue
        yield from iter_rows_for_entry(elem)
        elem.clear()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tei", required=True, type=Path, help="Path to the eng-xxx.tei file")
    parser.add_argument("--language", required=True, choices=["de", "fr", "it"], help="Target language code (informational; used in progress logging only)")
    parser.add_argument("--out", required=True, type=Path, help="Output JSONL path")
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)

    row_count = 0
    with args.out.open("w", encoding="utf-8") as handle:
        for row in parse_tei(args.tei):
            handle.write(json.dumps(row, ensure_ascii=False))
            handle.write("\n")
            row_count += 1
            if row_count % 100_000 == 0:
                print(f"[{args.language}] {row_count} rows written...")

    print(f"[{args.language}] done: {row_count} rows -> {args.out}")


if __name__ == "__main__":
    main()
