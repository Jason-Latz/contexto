#!/usr/bin/env python3
"""Deterministic evidence merge for Contexto language packs.

For every entry in every pack (core + tail, es/de/fr/it) this cross-references
FIVE independent, non-LLM sources and emits one JSONL record per pack entry to
pipeline/data/evidence/{lang}-evidence.jsonl. No LLM calls happen here — this is
pure deterministic bucketing so a downstream LLM-adjudication pass only has to
look at the "ambiguous" residual, not the whole pack.

Sources cross-referenced (see `SOURCE_AVAILABILITY` for the real per-language
matrix — it is NOT symmetric, verified by reading the actual files):
  - freedict-eng-{de,fr,it}.jsonl   (translation vote; NOT available for es)
  - apertium-eng-{es,de,fr,it}.jsonl (translation vote)
  - omw-eng-{es,fr,it}.jsonl         (translation vote + dominant-sense rank;
                                      NOT available for de — no omw-eng-de.jsonl
                                      file exists in this source set)
  - en-tr-cache.jsonl                (translation vote + which English sense
                                      bucket contains the target — "entr")
  - wikidata-lexemes-{es,de,fr,it}.jsonl (gender/plural morphology authority)
  - target-language Wiktextract dumps (gender/plural morphology authority for
    de/fr/it only). IMPORTANT: pipeline/data/kaikki.jsonl is documented
    elsewhere (Textum/CLAUDE.md) as "the Spanish dump if needed" — that is
    WRONG. Reading it shows lang_code "de" throughout; it is a (slightly
    older) copy of the German Wiktextract extract, not Spanish. There is no
    Spanish target-language Wiktextract dump in this repo, so `wiktextract`
    morphology is always null for es. Flagged for the user separately.

Two-tier resolution model
--------------------------
1. Translation resolution (primary bucket), computed from vote counts:
     - "no-evidence"   the English key is absent from every translation source
     - "flag-retarget" current target is weakly attested (<=1 vote) while a
                        different target is strongly attested (>=2 votes) in a
                        dominant WordNet sense (omwBestSenseRank <= 2)
     - "confirm"        current target has >=2 votes and no such stronger
                        alternative exists
     - "ambiguous"      evidence exists but neither rule above fires
2. Morphology flags (gender/plural), computed independently from the two
   morphology authorities (wikidata, wiktextract). A flag fires when EVERY
   authority that is actually present disagrees with the pack's gender/plural
   (this is exactly what `agreesGender`/`agreesPlural` being False means — see
   `combine_agreement`).

Final `resolution` priority: no-evidence > flag-retarget > flag-gender >
flag-plural > confirm > ambiguous. flags[] always lists every morphology
problem found (["gender"], ["plural"], both, or empty), independent of which
one won the `resolution` slot, so a "flag-retarget" record with a bad gender
too is not silently lost.

Normalization: English join keys are compared lowercase, whitespace-collapsed,
verbatim (no article/hyphen rewriting — the raw sources did not need it, see
notes). Target strings are compared lowercase + whitespace-collapsed
(case is not meaningful here: German nouns are always capitalized in the pack
but not consistently across raw sources). Accents are NOT folded for the
primary exact-match vote — an accent-only difference is recorded as a
"near miss" in `accentNearMisses` instead of silently counting as a vote.
"""
from __future__ import annotations

import json
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKS_DIR = REPO_ROOT / "public" / "language-packs"
SOURCES_DIR = REPO_ROOT / "pipeline" / "data" / "sources"
WIKT_CACHE_DIR = REPO_ROOT / "pipeline" / "data" / "wikt-cache"
EVIDENCE_DIR = REPO_ROOT / "pipeline" / "data" / "evidence"
ENTR_CACHE_PATH = REPO_ROOT / "pipeline" / "data" / "en-tr-cache.jsonl"

LANGUAGES = ["es", "de", "fr", "it"]

# Verified against the actual files in pipeline/data/sources/ — do not assume
# every language has every source. (No freedict-eng-es.jsonl. No omw-eng-de.jsonl.)
HAS_FREEDICT = {"de", "fr", "it"}
HAS_OMW = {"es", "fr", "it"}
# Verified: pipeline/data/kaikki.jsonl is German data (lang_code "de"), not
# Spanish, despite the CLAUDE.md note suggesting otherwise. No real Spanish
# target-language Wiktextract dump exists in this repo.
HAS_WIKT_TARGET_DUMP = {"de", "fr", "it"}

# Slim-cache construction was factored into pipeline/analysis/build_slim_wikt.py
# (single source of truth, reused by build_mint_queue.py too). merge_evidence
# only ever builds de/fr/it slim caches -- HAS_WIKT_TARGET_DUMP gates
# load_slim_wikt_noun_index below, so es is never built from here.
sys.path.insert(0, str(REPO_ROOT))
from pipeline.analysis.build_slim_wikt import build_slim_wikt_cache  # noqa: E402


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def norm(s: str | None) -> str:
    """Lowercase + collapse whitespace. Used for every join/compare key."""
    if not s:
        return ""
    return " ".join(s.strip().lower().split())


def fold_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def match_kind(current_norm: str, candidate_norm: str) -> str | None:
    """Return 'exact', 'near' (accent-only difference), or None."""
    if not current_norm or not candidate_norm:
        return None
    if current_norm == candidate_norm:
        return "exact"
    if fold_accents(current_norm) == fold_accents(candidate_norm):
        return "near"
    return None


# ---------------------------------------------------------------------------
# Slim target-language Wiktextract cache (built once by build_slim_wikt, reused
# across runs). build_slim_wikt_cache is imported at the top of this module.
# ---------------------------------------------------------------------------

def load_slim_wikt_noun_index(lang: str) -> dict[str, list[tuple[str | None, str | None]]]:
    """normalize(lemma) -> list of (gender, plural) for noun records only."""
    idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    if lang not in HAS_WIKT_TARGET_DUMP:
        return idx
    path = build_slim_wikt_cache(lang)
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec["pos"] != "noun":
                continue
            idx[norm(rec["lemma"])].append((rec.get("gender"), rec.get("plural")))
    return idx


# ---------------------------------------------------------------------------
# Raw source loaders (all indexed by normalized English join key, except
# wikidata which is indexed by normalized target lemma)
# ---------------------------------------------------------------------------

def load_freedict_index(lang: str) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = defaultdict(list)
    if lang not in HAS_FREEDICT:
        return idx
    path = SOURCES_DIR / f"freedict-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("en"))].append(r.get("target") or "")
    return idx


def load_apertium_index(lang: str) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = defaultdict(list)
    path = SOURCES_DIR / f"apertium-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("en"))].append(r.get("target") or "")
    return idx


def load_omw_index(lang: str) -> dict[str, list[tuple[int, list[str]]]]:
    idx: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    if lang not in HAS_OMW:
        return idx
    path = SOURCES_DIR / f"omw-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("en"))].append((r.get("senseRank") or 999, r.get("targets") or []))
    return idx


def load_wikidata_index(lang: str) -> dict[str, set[tuple[str | None, str | None]]]:
    idx: dict[str, set[tuple[str | None, str | None]]] = defaultdict(set)
    path = SOURCES_DIR / f"wikidata-lexemes-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("lemma"))].add((r.get("gender"), r.get("plural")))
    return idx


def load_entr_index() -> dict[str, list[dict]]:
    """normalize(en word) -> list of sense buckets (shared across all 4 langs)."""
    idx: dict[str, list[dict]] = defaultdict(list)
    with open(ENTR_CACHE_PATH, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("w"))].append({"pos": r.get("pos"), "tr": r.get("tr") or []})
    return idx


# ---------------------------------------------------------------------------
# Pack loading
# ---------------------------------------------------------------------------

def load_pack_entries(lang: str) -> list[dict]:
    out = []
    for suffix, tier in ((".json", "core"), (".tail.json", "tail")):
        path = PACKS_DIR / f"{lang}{suffix}"
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, entry in data["entries"].items():
            rec = dict(entry)
            rec["_key"] = key
            rec["_tier"] = tier
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Per-entry evidence computation
# ---------------------------------------------------------------------------

def build_record(lang: str, entry: dict, indexes: dict) -> dict:
    key = entry["_key"]
    source_word = entry.get("source") or key
    target = entry.get("target") or ""
    pos = entry.get("partOfSpeech")
    gender = entry.get("gender")
    plural = entry.get("plural")
    tier = entry["_tier"]

    en_key = norm(source_word) or norm(key)
    target_n = norm(target)

    freedict_idx = indexes["freedict"]
    apertium_idx = indexes["apertium"]
    omw_idx = indexes["omw"]
    entr_idx = indexes["entr"]
    wikidata_idx = indexes["wikidata"]
    wikt_noun_idx = indexes["wikt_noun"]

    freedict_targets = freedict_idx.get(en_key, [])
    apertium_targets = apertium_idx.get(en_key, [])
    omw_rows = omw_idx.get(en_key, [])
    entr_buckets = entr_idx.get(en_key, [])

    word_exists_anywhere = bool(freedict_targets or apertium_targets or omw_rows or entr_buckets)

    # ---- translation votes for the CURRENT target ----
    accent_near_misses: list[str] = []

    def bool_vote(candidates: list[str], source_name: str) -> bool:
        exact = False
        near = False
        for cand in candidates:
            kind = match_kind(target_n, norm(cand))
            if kind == "exact":
                exact = True
            elif kind == "near":
                near = True
        if not exact and near:
            accent_near_misses.append(source_name)
        return exact

    freedict_vote = bool_vote(freedict_targets, "freedict") if lang in HAS_FREEDICT else False
    apertium_vote = bool_vote(apertium_targets, "apertium")

    omw_present = False
    omw_best_sense_rank = None
    if lang in HAS_OMW:
        near_flag = False
        for sense_rank, targets in omw_rows:
            for cand in targets:
                kind = match_kind(target_n, norm(cand))
                if kind == "exact":
                    omw_present = True
                    if omw_best_sense_rank is None or sense_rank < omw_best_sense_rank:
                        omw_best_sense_rank = sense_rank
                elif kind == "near":
                    near_flag = True
        if not omw_present and near_flag:
            accent_near_misses.append("omw")

    entr_present = False
    entr_sense_index = None
    entr_sense_count = len(entr_buckets)
    near_flag = False
    for i, bucket in enumerate(entr_buckets):
        found_here = False
        for lc, cand, _tags in bucket["tr"]:
            if lc != lang:
                continue
            kind = match_kind(target_n, norm(cand))
            if kind == "exact":
                found_here = True
            elif kind == "near":
                near_flag = True
        if found_here:
            entr_present = True
            if entr_sense_index is None:
                entr_sense_index = i
    if not entr_present and near_flag:
        accent_near_misses.append("entr")

    votes_for_current = {
        "freedict": freedict_vote,
        "apertium": apertium_vote,
        "omw": {"present": omw_present, "bestSenseRank": omw_best_sense_rank},
        "entr": {"present": entr_present, "senseIndex": entr_sense_index, "senseCount": entr_sense_count},
    }
    n_votes_current = int(freedict_vote) + int(apertium_vote) + int(omw_present) + int(entr_present)

    # ---- alternative-target vote tally (for flag-retarget / confirm disqualification) ----
    alt_votes: dict[str, set[str]] = defaultdict(set)
    alt_orig_case: dict[str, str] = {}
    alt_omw_best_rank: dict[str, int] = {}

    def register(cand_raw: str, source_name: str, sense_rank: int | None = None) -> None:
        cn = norm(cand_raw)
        if not cn:
            return
        alt_votes[cn].add(source_name)
        alt_orig_case.setdefault(cn, cand_raw.strip())
        if sense_rank is not None:
            if cn not in alt_omw_best_rank or sense_rank < alt_omw_best_rank[cn]:
                alt_omw_best_rank[cn] = sense_rank

    if lang in HAS_FREEDICT:
        for t in freedict_targets:
            register(t, "freedict")
    for t in apertium_targets:
        register(t, "apertium")
    if lang in HAS_OMW:
        for sense_rank, targets in omw_rows:
            for t in targets:
                register(t, "omw", sense_rank)
    for bucket in entr_buckets:
        for lc, t, _tags in bucket["tr"]:
            if lc == lang:
                register(t, "entr")

    best_alt_key = None
    best_alt_n = -1
    for cn, sources in alt_votes.items():
        if cn == target_n:
            continue
        n = len(sources)
        rank = alt_omw_best_rank.get(cn)
        if n > best_alt_n or (n == best_alt_n and best_alt_key is not None and
                               (rank if rank is not None else 999) < (alt_omw_best_rank.get(best_alt_key) if alt_omw_best_rank.get(best_alt_key) is not None else 999)):
            best_alt_n = n
            best_alt_key = cn

    best_alternative = None
    if best_alt_key is not None and best_alt_n > n_votes_current:
        best_alternative = {
            "target": alt_orig_case.get(best_alt_key, best_alt_key),
            "nVotes": best_alt_n,
            "omwBestSenseRank": alt_omw_best_rank.get(best_alt_key),
        }

    # ---- translation resolution ----
    if not word_exists_anywhere:
        translation_resolution = "no-evidence"
    elif (n_votes_current <= 1 and best_alternative is not None and best_alternative["nVotes"] >= 2
          and best_alternative["omwBestSenseRank"] is not None and best_alternative["omwBestSenseRank"] <= 2):
        translation_resolution = "flag-retarget"
    elif (n_votes_current >= 2 and not (best_alternative is not None
          and best_alternative["omwBestSenseRank"] is not None and best_alternative["omwBestSenseRank"] <= 2)):
        translation_resolution = "confirm"
    else:
        translation_resolution = "ambiguous"

    # ---- morphology (nouns only) ----
    wikidata_m = None
    wiktextract_m = None
    agrees_gender = None
    agrees_plural = None
    flags: list[str] = []

    if pos == "noun" and (gender or plural):
        target_key = norm(target)
        wd_matches = wikidata_idx.get(target_key, set())
        wx_matches = wikt_noun_idx.get(target_key, [])

        wd_genders = {g for g, _p in wd_matches if g}
        wd_plurals = {p for _g, p in wd_matches if p}
        wx_genders = {g for g, _p in wx_matches if g}
        wx_plurals = {p for _g, p in wx_matches if p}

        wd_present = bool(wd_matches)
        wx_present = bool(wx_matches)

        if wd_present:
            wikidata_m = {"gender": sorted(wd_genders) or None, "plural": sorted(wd_plurals) or None}
        if wx_present:
            wiktextract_m = {"gender": sorted(wx_genders) or None, "plural": sorted(wx_plurals) or None}

        gender_checks = []
        if wd_present and gender:
            gender_checks.append(gender in wd_genders)
        if wx_present and gender:
            gender_checks.append(gender in wx_genders)
        if gender_checks:
            agrees_gender = any(gender_checks)
            if not agrees_gender:
                flags.append("gender")

        plural_checks = []
        pn = norm(plural) if plural else None
        if wd_present and pn:
            plural_checks.append(pn in {norm(p) for p in wd_plurals})
        if wx_present and pn:
            plural_checks.append(pn in {norm(p) for p in wx_plurals})
        if plural_checks:
            agrees_plural = any(plural_checks)
            if not agrees_plural:
                flags.append("plural")

    # ---- final resolution (priority: no-evidence > flag-retarget > flag-gender > flag-plural > confirm/ambiguous) ----
    if translation_resolution in ("no-evidence", "flag-retarget"):
        resolution = translation_resolution
    elif "gender" in flags:
        resolution = "flag-gender"
    elif "plural" in flags:
        resolution = "flag-plural"
    else:
        resolution = translation_resolution  # "confirm" or "ambiguous"

    return {
        "lang": lang,
        "key": key,
        "source": source_word,
        "target": target,
        "pos": pos,
        "gender": gender,
        "plural": plural,
        "tier": tier,
        "votesForCurrent": votes_for_current,
        "nVotesCurrent": n_votes_current,
        "bestAlternative": best_alternative,
        "accentNearMisses": accent_near_misses,
        "morphology": {
            "wikidata": wikidata_m,
            "wiktextract": wiktextract_m,
            "agreesGender": agrees_gender,
            "agreesPlural": agrees_plural,
        },
        "resolution": resolution,
        "flags": flags,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_language(lang: str) -> dict:
    log(f"=== {lang} ===")
    t0 = time.time()
    indexes = {
        "freedict": load_freedict_index(lang),
        "apertium": load_apertium_index(lang),
        "omw": load_omw_index(lang),
        "entr": load_entr_index_cached(),
        "wikidata": load_wikidata_index(lang),
        "wikt_noun": load_slim_wikt_noun_index(lang),
    }
    log(f"  indexes loaded in {time.time() - t0:.1f}s")

    entries = load_pack_entries(lang)
    log(f"  {len(entries)} pack entries (core+tail)")

    out_path = EVIDENCE_DIR / f"{lang}-evidence.jsonl"
    bucket_counts: dict[str, int] = defaultdict(int)
    flag_counts: dict[str, int] = defaultdict(int)
    t1 = time.time()
    with open(out_path, "w", encoding="utf-8") as fout:
        for entry in entries:
            rec = build_record(lang, entry, indexes)
            bucket_counts[rec["resolution"]] += 1
            for f in rec["flags"]:
                flag_counts[f] += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    log(f"  merged {len(entries)} entries in {time.time() - t1:.1f}s -> {out_path}")
    log(f"  buckets: {dict(bucket_counts)}")
    return {"total": len(entries), "buckets": dict(bucket_counts), "flags": dict(flag_counts)}


_ENTR_CACHE_SINGLETON = None


def load_entr_index_cached() -> dict[str, list[dict]]:
    global _ENTR_CACHE_SINGLETON
    if _ENTR_CACHE_SINGLETON is None:
        log("loading shared en-tr-cache index ...")
        t0 = time.time()
        _ENTR_CACHE_SINGLETON = load_entr_index()
        log(f"  en-tr-cache: {len(_ENTR_CACHE_SINGLETON)} keys in {time.time() - t0:.1f}s")
    return _ENTR_CACHE_SINGLETON


def main() -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    langs = sys.argv[1:] or LANGUAGES
    summary = {}
    for lang in langs:
        summary[lang] = run_language(lang)
    log("=== SUMMARY ===")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
