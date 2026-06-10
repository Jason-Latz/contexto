from __future__ import annotations

import re
from html import unescape

from .enrich import OptionalEnrichment
from .freedict import FREEDICT_SOURCE_ID
from .models import ImportCandidate, RawFreeDictEntry


POS_MAP: dict[str, str] = {
    "n": "noun",
    "pn": "noun",
    "adj": "adjective",
    "v": "verb",
    "adv": "adverb",
    "phraseologicalUnit": "expression",
    "proverb": "expression",
    "preposition": "function",
    "conjunction": "function",
    "determiner": "function",
    "pronoun": "function",
    "article": "function",
    "interjection": "function",
    "particle": "function",
    "postposition": "function",
    "numeral": "function",
}

FUNCTION_SUBTYPE: dict[str, str] = {
    "preposition": "preposition",
    "postposition": "preposition",
    "conjunction": "conjunction",
    "determiner": "determiner",
    "article": "determiner",
    "pronoun": "pronoun",
    "interjection": "pronoun",
    "particle": "pronoun",
    "numeral": "determiner",
}

POS_PRIORITY = {
    "function": 0,
    "adverb": 1,
    "verb": 2,
    "adjective": 3,
    "noun": 4,
    "expression": 5,
}

SOURCE_RE = re.compile(r"^[a-z][a-z' -]{0,58}[a-z]$")
TARGET_RE = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿¡' .-]+$")
BAD_TARGET_RE = re.compile(r"[,&;()/\\[\]{}<>_=+*#@|]|\.{3}|…|&[a-z]+;")
LEADING_CONTEXT_RE = re.compile(r"^\(([^)]{1,80})\)\s*")
FEMININE_ENDINGS = ("a", "ción", "sión", "dad", "tad", "tud", "umbre", "ie", "ez", "sis", "itis")
MASCULINE_ENDINGS = ("o", "or", "aje", "án", "ambre", "ete", "és", "ín", "ma")


def clean_text(value: str) -> str:
    return " ".join(unescape(value.replace("\xa0", " ")).split())


def clean_source(value: str) -> str | None:
    source = clean_text(value).lower()
    if not SOURCE_RE.fullmatch(source):
        return None
    if len(source.split()) > 4:
        return None
    if any(len(word) > 24 for word in source.split()):
        return None
    return source


def clean_target(value: str) -> str | None:
    target = clean_text(value)
    if not target or len(target) > 60:
        return None
    if BAD_TARGET_RE.search(target):
        return None
    if not TARGET_RE.fullmatch(target):
        return None
    return target


def clean_gloss(value: str) -> str | None:
    gloss = LEADING_CONTEXT_RE.sub("", clean_text(value)).strip()
    if not gloss:
        return None
    if len(gloss) > 180:
        gloss = gloss[:177].rstrip() + "..."
    return gloss


def strip_spanish_article(target: str) -> str:
    words = target.split()
    if words and words[0].lower() in {"el", "la", "los", "las", "un", "una", "unos", "unas"}:
        return " ".join(words[1:])
    return target


def infer_gender(target: str, enrichment: OptionalEnrichment) -> str | None:
    bare = strip_spanish_article(target).lower()
    if bare in enrichment.spanish_gender:
        return enrichment.spanish_gender[bare]

    words = target.lower().split()
    if words and words[0] in {"el", "un", "los", "unos"}:
        return "masculine"
    if words and words[0] in {"la", "una", "las", "unas"}:
        return "feminine"

    head = bare.split()[0] if bare.split() else bare
    if head.endswith(FEMININE_ENDINGS):
        return "feminine"
    if head.endswith(MASCULINE_ENDINGS):
        return "masculine"
    return None


def pluralize_word(word: str) -> str:
    if word.endswith("z"):
        return word[:-1] + "ces"
    if word[-1].lower() in "aeiouáéíóúü":
        return word + "s"
    return word + "es"


def infer_plural(target: str, enrichment: OptionalEnrichment) -> str | None:
    bare = strip_spanish_article(target)
    bare_lower = bare.lower()
    if bare_lower in enrichment.spanish_plural:
        return enrichment.spanish_plural[bare_lower]

    words = bare.split()
    if not words:
        return None

    words[0] = pluralize_word(words[0])
    return " ".join(words)


def confidence_for(source: str, target: str, raw: RawFreeDictEntry, enrichment: OptionalEnrichment) -> tuple[str, list[str]]:
    source_ids = [FREEDICT_SOURCE_ID]
    normalized_target = strip_spanish_article(target).lower()
    if (source, normalized_target) in enrichment.corroborated_pairs or (source, target.lower()) in enrichment.corroborated_pairs:
        source_ids.extend(sorted(enrichment.source_ids))
        return "high", source_ids
    return "medium", source_ids


def rank_priority(part_of_speech: str, raw_pos: str, source: str, confidence: str) -> int:
    confidence_priority = 0 if confidence == "high" else 1
    proper_noun_penalty = 4 if raw_pos == "pn" else 0
    phrase_penalty = min(3, max(0, len(source.split()) - 1))
    return confidence_priority * 100 + proper_noun_penalty * 10 + POS_PRIORITY[part_of_speech] + phrase_penalty


def normalize_entry(raw: RawFreeDictEntry, enrichment: OptionalEnrichment) -> ImportCandidate | None:
    part_of_speech = POS_MAP.get(raw.raw_pos)
    if part_of_speech is None:
        return None

    source = clean_source(raw.source)
    if source is None:
        return None

    if " " in source and part_of_speech != "function":
        part_of_speech = "expression"

    target = clean_target(raw.translations[0])
    if target is None:
        return None

    source_gloss = None
    if source in enrichment.glosses:
        source_gloss = clean_gloss(enrichment.glosses[source])
    if source_gloss is None:
        for definition in raw.definitions:
            source_gloss = clean_gloss(definition)
            if source_gloss is not None:
                break
    if source_gloss is None:
        return None

    confidence, source_ids = confidence_for(source, target, raw, enrichment)
    candidate = ImportCandidate(
        source=source,
        target=strip_spanish_article(target) if part_of_speech == "noun" else target,
        part_of_speech=part_of_speech,
        source_gloss=source_gloss,
        confidence=confidence,
        source_ids=source_ids,
        source_order=raw.source_order,
        rank_priority=rank_priority(part_of_speech, raw.raw_pos, source, confidence),
    )

    if part_of_speech == "noun":
        candidate.gender = infer_gender(target, enrichment)
        candidate.plural = infer_plural(target, enrichment)
        if candidate.gender is None or candidate.plural is None:
            return None

    if part_of_speech == "function":
        candidate.function_subtype = FUNCTION_SUBTYPE.get(raw.raw_pos, "pronoun")

    return candidate


def normalize_entries(raw_entries: list[RawFreeDictEntry], enrichment: OptionalEnrichment) -> list[ImportCandidate]:
    deduped: dict[str, ImportCandidate] = {}

    for raw in raw_entries:
        candidate = normalize_entry(raw, enrichment)
        if candidate is None:
            continue

        existing = deduped.get(candidate.source)
        if existing is None:
            deduped[candidate.source] = candidate
            continue

        if (candidate.rank_priority, candidate.source_order) < (existing.rank_priority, existing.source_order):
            deduped[candidate.source] = candidate

    return sorted(
        deduped.values(),
        key=lambda candidate: (
            candidate.rank_priority,
            candidate.source_order,
            candidate.source,
        ),
    )
