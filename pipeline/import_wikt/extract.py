"""Stream a kaikki Wiktextract JSONL extract into en→target candidates.

Each target-language record (e.g. German "Hund") carries English glosses plus
authoritative gender + plural. We invert it: every clean English gloss-piece
becomes a candidate keyed by that English lemma, pointing at the target word.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Iterator

# Wiktextract part-of-speech → Contexto content part-of-speech.
POS_MAP = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb"}

_PARENS = re.compile(r"\([^)]*\)")
_BRACKETS = re.compile(r"\[[^\]]*\]")
_ARTICLE = re.compile(r"^(a|an|the)\s+", re.I)
# Glosses are frequently synonym lists ("dog; hound", "big, large"): split them.
_SPLIT = re.compile(r"\s*[;,/]\s*|\s+\bor\b\s+")
_SINGLE_WORD = re.compile(r"[a-z][a-z'-]*")
_PHRASE = re.compile(r"[a-z][a-z' -]*")

# English function/relation words whose presence marks a gloss as a definitional
# fragment ("a kind of fish") rather than a lexical phrase ("ice cream"). Used to
# keep the multi-word (expression) tier clean.
_PHRASE_STOPWORDS = {
    "a", "an", "the", "of", "to", "and", "or", "but", "with", "without", "from",
    "into", "for", "by", "at", "on", "in", "as", "that", "which", "who", "whom",
    "whose", "this", "these", "those", "is", "are", "be", "being", "been", "it",
    "its", "their", "his", "her", "your", "our", "not", "no", "any", "some",
    "such", "etc", "eg", "ie", "esp", "especially", "something", "someone",
    "one", "type", "kind", "form", "way", "act", "person", "used",
}

# Sense tags that mark a translation as non-standard — penalised so the common,
# neutral target wins the inversion for a given English lemma.
_RESTRICTED_TAGS = {
    "obsolete", "archaic", "rare", "dated", "historical", "dialectal", "dialect",
    "regional", "slang", "informal", "colloquial", "vulgar", "derogatory",
    "offensive", "poetic", "literary", "humorous", "nonstandard",
}

_GENDER_FROM_LETTER = {"m": "masculine", "f": "feminine", "n": "neuter"}


@dataclass
class Candidate:
    source: str          # English lemma (lowercased key)
    part_of_speech: str  # contexto POS: noun/verb/adjective/adverb/expression
    target: str          # target-language word
    gender: str | None   # masculine/feminine/neuter (nouns only)
    plural: str | None   # target plural (nouns only)
    gloss: str           # full English gloss, for the hover definition
    score: float         # higher = better translation for `source`


def _gender_of(rec: dict) -> str | None:
    tags = set(rec.get("tags", []))
    for sense in rec.get("senses", []):
        tags |= set(sense.get("tags", []))
    for head in rec.get("head_templates", []):
        args = head.get("args", {})
        value = str(args.get("1", "") or args.get("g", "") or args.get("2", ""))
        letter = value[:1]
        if letter in _GENDER_FROM_LETTER:
            tags.add(_GENDER_FROM_LETTER[letter])
    for gender in ("masculine", "feminine", "neuter"):
        if gender in tags:
            return gender
    return None


def _plural_of(rec: dict) -> str | None:
    for form in rec.get("forms", []):
        tags = form.get("tags", [])
        if "plural" in tags and "singular" not in tags:
            value = (form.get("form") or "").strip()
            if value and value not in ("-", "—") and not value.startswith("-") and not value.endswith("-"):
                return value
    return None


def _is_form_of(sense: dict) -> bool:
    if sense.get("form_of") or sense.get("alt_of"):
        return True
    return any(t in ("form-of", "alt-of", "inflection-of") for t in sense.get("tags", []))


def _restricted_penalty(sense: dict) -> float:
    return 2.0 if (_RESTRICTED_TAGS & set(sense.get("tags", []))) else 0.0


def _clean_pieces(gloss: str):
    """Yield (lemma, n_words) for each clean English piece of a gloss."""
    base = _BRACKETS.sub("", _PARENS.sub("", gloss)).strip().lower()
    for piece in _SPLIT.split(base):
        g = _ARTICLE.sub("", piece.strip()).strip(" .,;:\"'")
        if not g:
            continue
        words = g.split()
        if len(words) == 1 and _SINGLE_WORD.fullmatch(g):
            yield g, 1
        elif 2 <= len(words) <= 3 and _PHRASE.fullmatch(g) and not (_PHRASE_STOPWORDS & set(words)):
            yield g, len(words)


def _valid_target(target: str) -> bool:
    if not target or any(ch.isdigit() for ch in target):
        return False
    return not target.startswith("-") and not target.endswith("-")


def iter_candidates(path: str, target_freq) -> Iterator[Candidate]:
    """Stream `path`, yielding en→target Candidates. `target_freq(word)->zipf`."""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            pos_w = rec.get("pos")
            content_pos = POS_MAP.get(pos_w)
            if content_pos is None:
                continue

            target = (rec.get("word") or "").strip()
            if not _valid_target(target):
                continue

            gender = plural = None
            if content_pos == "noun":
                gender = _gender_of(rec)
                plural = _plural_of(rec)
                if not (gender and plural):
                    continue

            # Phrase commonness ≈ its rarest content word (a leading function word
            # like "durch"/"den" must not inflate the score of an idiom). Penalise
            # multi-word targets so a single English word prefers a single target word.
            target_words = target.split()
            nonzero = [f for f in (target_freq(w) for w in target_words) if f > 0]
            base_freq = min(nonzero) if nonzero else 0.0
            target_len_penalty = 0.8 * (len(target_words) - 1)

            for sense_index, sense in enumerate(rec.get("senses", [])):
                if _is_form_of(sense):
                    continue
                glosses = sense.get("glosses") or []
                if not glosses:
                    continue
                full_gloss = glosses[0].strip()
                penalty = _restricted_penalty(sense)
                for gloss in glosses:
                    for piece, n_words in _clean_pieces(gloss):
                        # Cognates (German "Hand" → English "hand") are valid
                        # translations, so identical spellings are kept on purpose.
                        kind = content_pos if n_words == 1 else "expression"
                        score = (base_freq - 0.4 * sense_index - penalty
                                 - 0.25 * (n_words - 1) - target_len_penalty)
                        yield Candidate(
                            source=piece,
                            part_of_speech=kind,
                            target=target,
                            gender=gender if kind != "expression" else None,
                            plural=plural if kind != "expression" else None,
                            gloss=full_gloss,
                            score=score,
                        )
