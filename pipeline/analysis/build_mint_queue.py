#!/usr/bin/env python3
"""Build the mint queue: net-new English word candidates Contexto could teach but
doesn't yet, one queue per language, for downstream LLM adjudication.

A "candidate" is (english word, lang) where the word is absent from that lang's
core+tail pack. The universe of candidates comes from
pipeline/data/universe/en-candidates.jsonl (built by the Phase 0 foundry): each
row is one English lemma with the enZipf frequency and the list of languages it
is missing in.

For each candidate we cross-reference the same independent, non-LLM sources used
by pipeline/analysis/merge_evidence.py (the audit-side evidence merge) to find
target-language words that ANY source proposes, tally distinct-source votes per
target, and KEEP the candidate only if some target clears the vote gate
(default >=2, override with --min-votes N). Vote sources, each counting once
regardless of how many rows they contribute:
  freedict, apertium, omw, en-tr-cache ("entr"), and the "wiktgloss" agreement
  vote -- the target-language Wiktextract entry for the proposed target T carries
  English glosses, and if one of them IS the candidate English word W (strict
  lemma match), that target->source agreement counts as an independent vote (a
  different wiki community than the English-Wiktionary "entr" translation tables).
  wiktgloss only ever confirms a target another source already proposed, never
  invents one. Output is pipeline/data/queues/mint-{lang}.jsonl, ordered enZipf
  descending (teach the most useful missing words first), for the
  proposer/refuter/judge adjudication engine.

Source availability per language (verified against the actual files in
pipeline/data/sources/ — NOT symmetric, mirrors merge_evidence.py):
  - freedict-eng-{de,fr,it}.jsonl   (no es)
  - apertium-eng-{es,de,fr,it}.jsonl (all four)
  - omw-eng-{es,fr,it}.jsonl         (no de — no omw-eng-de.jsonl exists)
  - en-tr-cache.jsonl                (shared, filtered per lang by tr[].lc)

Morphology (gender/plural) is attached ONLY from the two authorities the rest of
the pipeline treats as authoritative — wikidata-lexemes-{lang}.jsonl and the slim
target-language Wiktextract cache (pipeline/data/wikt-cache/slim-{lang}.jsonl,
now including es). It is composed PER FIELD: gender/plural each come from wikidata
when wikidata has that field, else from wiktextract (authority reflects what was
used: "wikidata" / "wiktextract" / "wikidata+wiktextract"). This recovers the
~27k wikidata nouns that carry a gender but a NULL plural — the plural is filled
from wiktextract instead of the whole noun being dropped. FreeDict's per-row gender field
is NOT used as morphology authority here (consistent with merge_evidence.py and
the adjudication engine's rule that gender/plural come only from wikidata/
wiktextract). For es, the small documented wikidata contamination denylist
(pipeline/data/qa_wikidata_lexeme_contamination_candidates.jsonl) is applied
before using wikidata-es as a morphology source (STATE.md: real pt contamination
found in es, de/fr trustworthy, it usable-with-care).

Target-language glosses for each alternative come from the slim wikt caches
(de/fr/it). es has no target-language Wiktextract dump in this repo (verified —
see merge_evidence.py's docstring), so es alternatives fall back to an English
sense description (from the omw synset gloss, or FreeDict's `notes`, when
available), prefixed "(en) " so the adjudicator knows it isn't a target-language
definition.

RESUME SUPPORT: keys already present in pipeline/data/verdicts/final/mint-{lang}-*
.jsonl or pipeline/data/verdicts/fixup/mint-{lang}-*.jsonl are excluded, so
re-running this script after a partial adjudication run only emits remaining work.
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKS_DIR = REPO_ROOT / "public" / "language-packs"
SOURCES_DIR = REPO_ROOT / "pipeline" / "data" / "sources"
WIKT_CACHE_DIR = REPO_ROOT / "pipeline" / "data" / "wikt-cache"
UNIVERSE_PATH = REPO_ROOT / "pipeline" / "data" / "universe" / "en-candidates.jsonl"
ENTR_CACHE_PATH = REPO_ROOT / "pipeline" / "data" / "en-tr-cache.jsonl"
QUEUES_DIR = REPO_ROOT / "pipeline" / "data" / "queues"
VERDICTS_FINAL_DIR = REPO_ROOT / "pipeline" / "data" / "verdicts" / "final"
VERDICTS_FIXUP_DIR = REPO_ROOT / "pipeline" / "data" / "verdicts" / "fixup"
ES_WIKIDATA_DENYLIST_PATH = (
    REPO_ROOT / "pipeline" / "data" / "qa_wikidata_lexeme_contamination_candidates.jsonl"
)

LANGUAGES = ["es", "de", "fr", "it"]

# Verified against the actual files in pipeline/data/sources/ (mirrors merge_evidence.py).
HAS_FREEDICT = {"de", "fr", "it"}
HAS_OMW = {"es", "fr", "it"}
# Which languages CAN have a slim target-language Wiktextract cache (morphology +
# glosses + the wiktgloss agreement vote). de/fr/it always have; es joined once
# its Spanish dump landed (2026-07-15). Actual availability is still gated on the
# slim-<lang>.jsonl file EXISTING at run time -- a missing file is logged loudly
# and simply yields no wiktextract morph / glosses / wiktgloss vote for that lang.
HAS_WIKT_TARGET_DUMP = {"es", "de", "fr", "it"}

MAX_ALTERNATIVES = 5
MAX_GLOSSES = 2
# How many target-language glosses to KEEP per lemma for display (small) vs. how
# many to scan for the wiktgloss agreement vote (larger, so a match isn't missed
# just because it sits in a lower sense).
MAX_DISPLAY_GLOSSES = 6
MAX_MATCH_GLOSSES = 24
MIN_INDEPENDENT_VOTES = 2
# Fixed priority order used both for the independent-source vote count and for
# deterministic tie-breaking / display-casing precedence. "wiktgloss" (the
# target-language Wiktionary gloss-agreement vote) sorts last.
SOURCE_ORDER = ["freedict", "apertium", "omw", "entr", "wiktgloss"]
# Sources derived from the target-language Wiktextract slim cache. The wiktgloss
# vote must not be counted when the alternative already carries a slim-derived
# source (would double-count the SAME underlying dictionary). Today wiktgloss is
# the only slim-derived source, and it is only ever added to alternatives already
# proposed by a NON-slim source, so this guard never actually fires -- it is kept
# explicit so adding another slim-derived source later can't silently double-vote.
SLIM_DERIVED_SOURCES = {"wiktgloss"}
# Fixed strict-tier vote gloss-agreement quality bar. Independent of the --min-votes
# GATE: it is the "how many candidates reach 2 independent votes" quality signal we
# report the wiktgloss unlock / token-contains delta against.
QUALITY_VOTE_BAR = 2


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def norm(s: str | None) -> str:
    if not s:
        return ""
    return " ".join(s.strip().lower().split())


def fold_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


# ---------------------------------------------------------------------------
# Pack keys (read-only, dedup only)
# ---------------------------------------------------------------------------

def load_pack_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    for suffix in (".json", ".tail.json"):
        path = PACKS_DIR / f"{lang}{suffix}"
        data = json.loads(path.read_text(encoding="utf-8"))
        keys.update(norm(k) for k in data["entries"].keys())
    return keys


# ---------------------------------------------------------------------------
# Resume support
# ---------------------------------------------------------------------------

def load_already_adjudicated_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    for d in (VERDICTS_FINAL_DIR, VERDICTS_FIXUP_DIR):
        if not d.exists():
            continue
        for path in glob.glob(str(d / f"mint-{lang}-*.jsonl")):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    k = rec.get("key")
                    if k:
                        keys.add(norm(k))
    return keys


# ---------------------------------------------------------------------------
# Universe (candidates)
# ---------------------------------------------------------------------------

def load_universe() -> list[dict]:
    rows = []
    with open(UNIVERSE_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows.append({
                "word": r.get("word") or "",
                "enZipf": float(r.get("enZipf") or 0.0),
                "missingIn": set(r.get("missingIn") or []),
            })
    return rows


# ---------------------------------------------------------------------------
# Raw source loaders (indexed by normalized English join key)
# ---------------------------------------------------------------------------

def load_freedict_index(lang: str) -> dict[str, list[tuple[str, str | None]]]:
    idx: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    if lang not in HAS_FREEDICT:
        return idx
    path = SOURCES_DIR / f"freedict-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            target = r.get("target") or ""
            if not target:
                continue
            idx[norm(r.get("en"))].append((target, r.get("notes")))
    return idx


def load_apertium_index(lang: str) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = defaultdict(list)
    path = SOURCES_DIR / f"apertium-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            target = r.get("target") or ""
            if target:
                idx[norm(r.get("en"))].append(target)
    return idx


def load_omw_index(lang: str) -> dict[str, list[tuple[int, str, list[str]]]]:
    idx: dict[str, list[tuple[int, str, list[str]]]] = defaultdict(list)
    if lang not in HAS_OMW:
        return idx
    path = SOURCES_DIR / f"omw-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            targets = r.get("targets") or []
            if not targets:
                continue
            idx[norm(r.get("en"))].append((r.get("senseRank") or 999, r.get("gloss") or "", targets))
    return idx


def load_wikidata_index(lang: str) -> dict[str, list[tuple[str | None, str | None]]]:
    idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    path = SOURCES_DIR / f"wikidata-lexemes-{lang}.jsonl"
    denylist = ES_WIKIDATA_DENYLIST if lang == "es" else set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            lemma = r.get("lemma") or ""
            key = norm(lemma)
            if key in denylist:
                continue
            idx[key].append((r.get("gender"), r.get("plural")))
    return idx


def load_es_wikidata_denylist() -> set[str]:
    denylist: set[str] = set()
    if not ES_WIKIDATA_DENYLIST_PATH.exists():
        return denylist
    with open(ES_WIKIDATA_DENYLIST_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("lang") == "es" and r.get("lemma"):
                denylist.add(norm(r["lemma"]))
    return denylist


ES_WIKIDATA_DENYLIST: set[str] = set()


def load_entr_index() -> dict[str, list[dict]]:
    """normalize(en word) -> list of sense buckets, one per (word, pos, gloss) row
    in en-tr-cache.jsonl, each carrying its own English gloss and per-language
    translation candidates. Shared across all four languages.
    """
    idx: dict[str, list[dict]] = defaultdict(list)
    with open(ENTR_CACHE_PATH, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("w"))].append({
                "pos": r.get("pos"),
                "gloss": r.get("g") or "",
                "tr": r.get("tr") or [],
            })
    return idx


# ---------------------------------------------------------------------------
# Slim target-language Wiktextract cache (already built by merge_evidence.py)
# ---------------------------------------------------------------------------

def load_slim_wikt_indexes(
    lang: str,
) -> tuple[dict[str, list[tuple[str | None, str | None]]], dict[str, list[str]], dict[str, list[str]]]:
    """Returns (noun_morph_idx, display_gloss_idx, match_gloss_idx).

    - noun_morph_idx  covers `noun` rows only (gender/plural authority).
    - display_gloss_idx covers every POS, capped small (shown as the
      alternative's target-language definition regardless of its POS).
    - match_gloss_idx covers every POS, capped larger and lowercased -- scanned
      by the wiktgloss agreement vote so a match in a lower sense isn't missed.

    Availability is gated on the slim-<lang>.jsonl file EXISTING; a missing file
    is logged loudly and yields three empty indexes (no wiktextract morph / gloss
    / wiktgloss vote for that language) rather than an error.
    """
    noun_idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    display_idx: dict[str, list[str]] = defaultdict(list)
    match_idx: dict[str, list[str]] = defaultdict(list)
    if lang not in HAS_WIKT_TARGET_DUMP:
        return noun_idx, display_idx, match_idx
    path = WIKT_CACHE_DIR / f"slim-{lang}.jsonl"
    if not path.exists():
        log(f"  [slim] no {path.name} present -> NO wiktextract morph / gloss / "
            f"wiktgloss vote for {lang} (run: python3 -m pipeline.analysis.build_slim_wikt {lang})")
        return noun_idx, display_idx, match_idx
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            lemma_key = norm(rec.get("lemma"))
            if not lemma_key:
                continue
            if rec.get("pos") == "noun":
                noun_idx[lemma_key].append((rec.get("gender"), rec.get("plural")))
            for g in rec.get("glosses") or []:
                if not g:
                    continue
                if len(display_idx[lemma_key]) < MAX_DISPLAY_GLOSSES:
                    display_idx[lemma_key].append(g)
                if len(match_idx[lemma_key]) < MAX_MATCH_GLOSSES:
                    match_idx[lemma_key].append(g.lower())
    return noun_idx, display_idx, match_idx


# ---------------------------------------------------------------------------
# Gloss-match agreement vote (wiktgloss)
# ---------------------------------------------------------------------------
# The target-language Wiktionary entry for target T carries English glosses. If
# one of them, as a standalone lemma, IS the English candidate word W, that is an
# independent second opinion (target->source) on top of the source->target
# translation dictionaries -- edited by a different wiki community than the
# English Wiktionary translation tables that produce the "entr" vote, hence
# counted as an independent source.

_LEADING_ARTICLE_RE = re.compile(r"^(a|an|the)\s+")
_TRAILING_PUNCT = " \t.,;:!?\"'`()[]"
_TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def _reduce_gloss_segment(seg: str) -> str:
    """Lowercase, strip a single leading article and surrounding punctuation."""
    seg = seg.strip().lower()
    seg = _LEADING_ARTICLE_RE.sub("", seg)
    return seg.strip(_TRAILING_PUNCT)


def gloss_matches_word_strict(gloss: str, word: str) -> bool:
    """STRICT tier: the gloss (whole, or one comma/semicolon segment), lowercased
    and stripped of a leading article + trailing punctuation, EQUALS `word`.
    Definitional glosses ("related to war", "a kind of dog", "foot (a part of the
    body)") deliberately do NOT match -- only clean single-lemma glosses do."""
    w = word.strip().lower()
    if not w:
        return False
    if _reduce_gloss_segment(gloss) == w:
        return True
    for seg in re.split(r"[;,]", gloss):
        if _reduce_gloss_segment(seg) == w:
            return True
    return False


def gloss_tokencontains_word(gloss: str, word: str) -> bool:
    """MEASUREMENT ONLY (never shipped): `word` appears as a whole token anywhere
    in the gloss. A strict superset of gloss_matches_word_strict; the gap between
    the two is the recall we knowingly leave on the table for precision."""
    w = word.strip().lower()
    if not w:
        return False
    return w in _TOKEN_RE.findall(gloss.lower())


# ---------------------------------------------------------------------------
# Morphology composition (compose wikidata + wiktextract per FIELD)
# ---------------------------------------------------------------------------

def _best_field(pairs: list[tuple[str | None, str | None]], index: int) -> str | None:
    """Most-common non-null value at tuple position `index` (0=gender, 1=plural)."""
    vals = [p[index] for p in pairs if p[index]]
    if not vals:
        return None
    return Counter(vals).most_common(1)[0][0]


def compose_morph(
    wd_pairs: list[tuple[str | None, str | None]],
    wx_pairs: list[tuple[str | None, str | None]],
) -> dict | None:
    """Compose morphology per field: gender/plural each come from wikidata when
    wikidata has that field, else from wiktextract. Fixes the old all-or-nothing
    source pick that dropped ~27k wikidata nouns which have gender but a NULL
    plural (the plural is then filled from wiktextract). `authority` reflects
    which source(s) actually contributed: "wikidata", "wiktextract", or
    "wikidata+wiktextract". Returns None only when neither field is available.
    (Nouns still need BOTH gender and plural to be mintable -- enforced by
    apply_verdicts, not here.)"""
    wd_gender = _best_field(wd_pairs, 0)
    wd_plural = _best_field(wd_pairs, 1)
    wx_gender = _best_field(wx_pairs, 0)
    wx_plural = _best_field(wx_pairs, 1)

    gender = wd_gender if wd_gender else wx_gender
    plural = wd_plural if wd_plural else wx_plural
    if gender is None and plural is None:
        return None

    gender_src = "wikidata" if wd_gender else ("wiktextract" if wx_gender else None)
    plural_src = "wikidata" if wd_plural else ("wiktextract" if wx_plural else None)
    order = {"wikidata": 0, "wiktextract": 1}
    used: list[str] = []
    for s in (gender_src, plural_src):
        if s and s not in used:
            used.append(s)
    used.sort(key=lambda s: order[s])
    return {"gender": gender, "plural": plural, "authority": "+".join(used)}


# ---------------------------------------------------------------------------
# Per-candidate alternative building
# ---------------------------------------------------------------------------

def build_alternatives_and_check_gate(
    lang: str,
    en_key: str,
    indexes: dict,
    min_votes: int = MIN_INDEPENDENT_VOTES,
) -> tuple[list[dict], set[str], bool, dict]:
    """Returns (alternatives[<=5, best first], all_alt_norm_keys, passes_vote_gate,
    diag). `diag` carries the per-candidate vote-strength signals used for the
    evidence breakdown: trueBest (best real-dictionary vote count, EXCLUDING the
    wiktgloss agreement vote), strictBest (best count INCLUDING strict wiktgloss),
    tcBest (best count if wiktgloss used the un-shipped token-contains rule)."""
    freedict_rows = indexes["freedict"].get(en_key, [])
    apertium_targets = indexes["apertium"].get(en_key, [])
    omw_rows = indexes["omw"].get(en_key, [])
    entr_buckets = indexes["entr"].get(en_key, [])

    alt_sources: dict[str, set[str]] = defaultdict(set)
    alt_orig_case: dict[str, str] = {}
    alt_omw_best_rank: dict[str, int] = {}
    alt_omw_glosses: dict[str, list[str]] = defaultdict(list)
    alt_freedict_notes: dict[str, list[str]] = defaultdict(list)

    def register(cand_raw: str, source_name: str, sense_rank: int | None = None, omw_gloss: str | None = None) -> None:
        cn = norm(cand_raw)
        if not cn:
            return
        alt_sources[cn].add(source_name)
        alt_orig_case.setdefault(cn, cand_raw.strip())
        if sense_rank is not None:
            if cn not in alt_omw_best_rank or sense_rank < alt_omw_best_rank[cn]:
                alt_omw_best_rank[cn] = sense_rank
        if omw_gloss and len(alt_omw_glosses[cn]) < MAX_GLOSSES:
            alt_omw_glosses[cn].append(omw_gloss)

    for target, notes in freedict_rows:
        register(target, "freedict")
        if notes:
            cn = norm(target)
            if len(alt_freedict_notes[cn]) < MAX_GLOSSES:
                alt_freedict_notes[cn].append(notes)
    for target in apertium_targets:
        register(target, "apertium")
    for sense_rank, gloss, targets in omw_rows:
        for target in targets:
            register(target, "omw", sense_rank, gloss)
    for bucket in entr_buckets:
        for lc, target, _tags in bucket["tr"]:
            if lc == lang:
                register(target, "entr")

    if not alt_sources:
        return [], set(), False, {"trueBest": 0, "strictBest": 0, "tcBest": 0}

    noun_idx = indexes["wikt_noun"]
    gloss_idx = indexes["wikt_gloss"]
    match_gloss_idx = indexes["wikt_match_gloss"]
    wikidata_idx = indexes["wikidata"]

    # ---- wiktgloss agreement vote (strict) + token-contains measurement ----
    # Only ever CONFIRMS a target another (non-slim) source already proposed --
    # never invents a new alternative -- so every alternative keeps >=1 real
    # dictionary vote and wiktgloss can only push an existing target over the bar.
    tc_only_keys: set[str] = set()  # matched by token-contains but NOT by strict
    for cn in list(alt_sources.keys()):
        match_glosses = match_gloss_idx.get(cn, [])
        if not match_glosses:
            continue
        if any(gloss_matches_word_strict(g, en_key) for g in match_glosses):
            if not (alt_sources[cn] & SLIM_DERIVED_SOURCES):  # never double-count
                alt_sources[cn].add("wiktgloss")
        elif any(gloss_tokencontains_word(g, en_key) for g in match_glosses):
            tc_only_keys.add(cn)

    def real_votes(cn: str) -> int:
        return len(alt_sources[cn] - SLIM_DERIVED_SOURCES)

    def tc_votes(cn: str) -> int:
        would_have_wiktgloss = ("wiktgloss" in alt_sources[cn]) or (cn in tc_only_keys)
        return real_votes(cn) + (1 if would_have_wiktgloss else 0)

    strict_best = max(len(alt_sources[cn]) for cn in alt_sources)
    true_best = max(real_votes(cn) for cn in alt_sources)
    tc_best = max(tc_votes(cn) for cn in alt_sources)
    passes = strict_best >= min_votes
    diag = {"trueBest": true_best, "strictBest": strict_best, "tcBest": tc_best}

    ranked = sorted(
        alt_sources.keys(),
        key=lambda cn: (
            -len(alt_sources[cn]),
            alt_omw_best_rank.get(cn, 999),
            cn,
        ),
    )

    alternatives = []
    for cn in ranked[:MAX_ALTERNATIVES]:
        sources_sorted = [s for s in SOURCE_ORDER if s in alt_sources[cn]]
        votes = len(alt_sources[cn])

        morph = compose_morph(wikidata_idx.get(cn, []), noun_idx.get(cn, []))

        glosses = list(gloss_idx.get(cn, []))[:MAX_GLOSSES]
        if not glosses:
            fallback = list(alt_omw_glosses.get(cn, [])) + list(alt_freedict_notes.get(cn, []))
            glosses = [f"(en) {g}" for g in fallback[:MAX_GLOSSES]]

        alternatives.append({
            "target": alt_orig_case.get(cn, cn),
            "votes": votes,
            "sources": sources_sorted,
            "omwBestSenseRank": alt_omw_best_rank.get(cn),
            "glosses": glosses,
            "morph": morph,
        })

    return alternatives, set(alt_sources.keys()), passes, diag


def build_entr_senses(lang: str, en_key: str, entr_idx: dict, all_alt_keys: set[str]) -> list[dict]:
    buckets = entr_idx.get(en_key, [])
    out = []
    for bucket in buckets:
        contains_any = False
        for lc, target, _tags in bucket["tr"]:
            if lc == lang and norm(target) in all_alt_keys:
                contains_any = True
                break
        out.append({"gloss": bucket["gloss"], "containsAny": contains_any})
    return out


# ---------------------------------------------------------------------------
# Per-language run
# ---------------------------------------------------------------------------

def _legacy_morph(wd_pairs, wx_pairs) -> tuple[str | None, str | None]:
    """The OLD all-or-nothing morph pick (most-common wikidata pair with a
    non-null gender, else the same from wiktextract). Used ONLY for the
    before/after coverage measurement -- never for anything emitted."""
    for pairs in (wd_pairs, wx_pairs):
        usable = [(g, p) for g, p in pairs if g]
        if usable:
            return Counter(usable).most_common(1)[0][0]
    return None, None


def run_language(lang: str, universe: list[dict], entr_idx: dict, min_votes: int) -> dict:
    log(f"=== {lang} (min_votes={min_votes}) ===")
    t0 = time.time()
    pack_keys = load_pack_keys(lang)
    excluded_keys = load_already_adjudicated_keys(lang)
    noun_idx, gloss_idx, match_gloss_idx = load_slim_wikt_indexes(lang)
    wikidata_idx = load_wikidata_index(lang)
    indexes = {
        "freedict": load_freedict_index(lang),
        "apertium": load_apertium_index(lang),
        "omw": load_omw_index(lang),
        "entr": entr_idx,
        "wikidata": wikidata_idx,
        "wikt_noun": noun_idx,
        "wikt_gloss": gloss_idx,
        "wikt_match_gloss": match_gloss_idx,
    }
    log(f"  indexes loaded in {time.time() - t0:.1f}s "
        f"(pack_keys={len(pack_keys)}, already_adjudicated={len(excluded_keys)}, "
        f"wiktgloss_lemmas={len(match_gloss_idx)})")

    t1 = time.time()
    records = []
    considered = 0
    # Evidence breakdown, computed over ALL candidates that have any alternative
    # (independent of the --min-votes gate) so the 2-vote quality signal + the
    # wiktgloss unlock + the un-shipped token-contains delta are all measurable.
    ev = Counter()
    for row in universe:
        if lang not in row["missingIn"]:
            continue
        word = row["word"]
        key = norm(word)
        if not key or key in pack_keys or key in excluded_keys:
            continue
        considered += 1

        alternatives, all_alt_keys, passes, diag = build_alternatives_and_check_gate(
            lang, key, indexes, min_votes)
        if not alternatives:
            continue

        true_best, strict_best, tc_best = diag["trueBest"], diag["strictBest"], diag["tcBest"]
        ev["cand_with_alts"] += 1
        if strict_best >= QUALITY_VOTE_BAR:
            ev["reach2_strict"] += 1
            if true_best < QUALITY_VOTE_BAR:
                ev["reach2_only_via_wiktgloss"] += 1
        if tc_best >= QUALITY_VOTE_BAR:
            ev["reach2_tokencontains"] += 1
            if strict_best < QUALITY_VOTE_BAR:
                ev["tokencontains_delta_not_shipped"] += 1

        if not passes:
            continue

        # ---- emitted-row evidence + morph before/after (best alternative) ----
        ev["emitted"] += 1
        if true_best >= 2:
            ev["emitted_ge2_true_votes"] += 1
        elif strict_best >= 2:
            ev["emitted_reached2_only_via_wiktgloss"] += 1
        if strict_best == 1:
            ev["emitted_pure_single_vote"] += 1

        best_alt = alternatives[0]
        bn = norm(best_alt["target"])
        new_morph = best_alt.get("morph") or {}
        new_full = bool(new_morph.get("gender")) and bool(new_morph.get("plural"))
        old_g, old_p = _legacy_morph(wikidata_idx.get(bn, []), noun_idx.get(bn, []))
        old_full = bool(old_g) and bool(old_p)
        if new_morph.get("gender") or old_g:  # a candidate-noun (has a gender signal)
            ev["emitted_bestalt_noun_like"] += 1
            if old_full:
                ev["emitted_bestalt_morph_full_before"] += 1
            if new_full:
                ev["emitted_bestalt_morph_full_after"] += 1

        entr_senses = build_entr_senses(lang, key, entr_idx, all_alt_keys)
        enzipf = row["enZipf"]
        records.append({
            "lang": lang,
            "key": key,
            "source": word,
            "enZipf": enzipf,
            "entrSenses": entr_senses,
            "alternatives": alternatives,
            "shipTierHint": "tail" if enzipf < 5.0 else "core-gap",
        })

    records.sort(key=lambda r: (-r["enZipf"], r["key"]))

    QUEUES_DIR.mkdir(parents=True, exist_ok=True)
    out_path = QUEUES_DIR / f"mint-{lang}.jsonl"
    with open(out_path, "w", encoding="utf-8") as fout:
        for rec in records:
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")

    log(f"  {considered} candidates considered -> {len(records)} passed the "
        f">={min_votes}-source-vote gate in {time.time() - t1:.1f}s -> {out_path}")
    log(f"  evidence: {json.dumps(dict(ev), sort_keys=True)}")
    return {"queueSize": len(records), "considered": considered, "evidence": dict(ev)}


def main(argv=None) -> None:
    global ES_WIKIDATA_DENYLIST
    ES_WIKIDATA_DENYLIST = load_es_wikidata_denylist()
    log(f"loaded es wikidata contamination denylist: {len(ES_WIKIDATA_DENYLIST)} lemmas")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("languages", nargs="*", default=None,
                        help="languages to build (default: es de fr it)")
    parser.add_argument("--min-votes", type=int, default=MIN_INDEPENDENT_VOTES,
                        help="minimum independent source votes a target must clear to "
                             f"keep a candidate (default {MIN_INDEPENDENT_VOTES}; the "
                             "wiktgloss agreement vote counts toward this)")
    args = parser.parse_args(argv)
    langs = args.languages or LANGUAGES
    min_votes = args.min_votes

    log("loading candidate universe ...")
    t0 = time.time()
    universe = load_universe()
    log(f"  {len(universe)} candidate rows in {time.time() - t0:.1f}s")

    log("loading shared en-tr-cache index ...")
    t0 = time.time()
    entr_idx = load_entr_index()
    log(f"  {len(entr_idx)} keys in {time.time() - t0:.1f}s")

    results = {}
    for lang in langs:
        results[lang] = run_language(lang, universe, entr_idx, min_votes)

    counts = {lang: r["queueSize"] for lang, r in results.items()}
    log(f"=== SUMMARY === {json.dumps(counts)}")
    print(json.dumps({"minVotes": min_votes, "counts": counts,
                      "perLanguage": results, "goldBatches": 0}, indent=2))


if __name__ == "__main__":
    main()
