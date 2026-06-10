from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class OptionalEnrichment:
    glosses: dict[str, str] = field(default_factory=dict)
    corroborated_pairs: set[tuple[str, str]] = field(default_factory=set)
    spanish_gender: dict[str, str] = field(default_factory=dict)
    spanish_plural: dict[str, str] = field(default_factory=dict)
    source_ids: set[str] = field(default_factory=set)


def _load_jsonl(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    if not path.exists():
        return rows

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_optional_enrichment(cache_dir: Path) -> OptionalEnrichment:
    """Load local Kaikki/OMW/Apertium enrichment data when present.

    The 50k import remains deterministic without these large optional files.
    When they are added to the cache, they can improve glosses, noun metadata,
    and confidence scoring without changing the public runtime API.
    """

    glosses: dict[str, str] = {}
    spanish_gender: dict[str, str] = {}
    spanish_plural: dict[str, str] = {}
    corroborated_pairs: set[tuple[str, str]] = set()
    source_ids: set[str] = set()

    english_kaikki = cache_dir / "kaikki-en-extract.jsonl"
    for row in _load_jsonl(english_kaikki):
        word = str(row.get("word", "")).strip().lower()
        senses = row.get("senses")
        if not word or not isinstance(senses, list):
            continue
        for sense in senses:
            if not isinstance(sense, dict):
                continue
            glosses_list = sense.get("glosses")
            if isinstance(glosses_list, list) and glosses_list:
                glosses.setdefault(word, str(glosses_list[0]).strip())
                source_ids.add("kaikki-en")
                break

    spanish_kaikki = cache_dir / "kaikki-es-extract.jsonl"
    for row in _load_jsonl(spanish_kaikki):
        word = str(row.get("word", "")).strip().lower()
        if not word:
            continue
        forms = row.get("forms")
        if isinstance(forms, list):
            for form in forms:
                if not isinstance(form, dict):
                    continue
                tags = form.get("tags")
                form_word = str(form.get("form", "")).strip().lower()
                if isinstance(tags, list) and form_word:
                    if "feminine" in tags:
                        spanish_gender.setdefault(word, "feminine")
                    if "masculine" in tags:
                        spanish_gender.setdefault(word, "masculine")
                    if "plural" in tags:
                        spanish_plural.setdefault(word, form_word)
                        source_ids.add("kaikki-es")

    omw_pairs = cache_dir / "omw-es-pairs.jsonl"
    for row in _load_jsonl(omw_pairs):
        source = str(row.get("source", "")).strip().lower()
        target = str(row.get("target", "")).strip().lower()
        if source and target:
            corroborated_pairs.add((source, target))
            source_ids.add("omw")

    apertium_pairs = cache_dir / "apertium-eng-spa-pairs.jsonl"
    for row in _load_jsonl(apertium_pairs):
        source = str(row.get("source", "")).strip().lower()
        target = str(row.get("target", "")).strip().lower()
        if source and target:
            corroborated_pairs.add((source, target))
            source_ids.add("apertium-eng-spa")

    return OptionalEnrichment(
        glosses=glosses,
        corroborated_pairs=corroborated_pairs,
        spanish_gender=spanish_gender,
        spanish_plural=spanish_plural,
        source_ids=source_ids,
    )
