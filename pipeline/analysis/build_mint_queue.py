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
target, and KEEP the candidate only if some target clears >=2 independent source
votes (freedict, apertium, omw, en-tr-cache each count once regardless of how many
rows they contribute). Output is pipeline/data/queues/mint-{lang}.jsonl, ordered
enZipf descending (teach the most useful missing words first), for the
proposer/refuter/judge adjudication engine.

Source availability per language (verified against the actual files in
pipeline/data/sources/ — NOT symmetric, mirrors merge_evidence.py):
  - freedict-eng-{de,fr,it}.jsonl   (no es)
  - apertium-eng-{es,de,fr,it}.jsonl (all four)
  - omw-eng-{es,fr,it}.jsonl         (no de — no omw-eng-de.jsonl exists)
  - en-tr-cache.jsonl                (shared, filtered per lang by tr[].lc)

Morphology (gender/plural) is attached ONLY from the two authorities the rest of
the pipeline treats as authoritative — wikidata-lexemes-{lang}.jsonl and, for
de/fr/it, the slim target-language Wiktextract cache
(pipeline/data/wikt-cache/slim-{de,fr,it}.jsonl). FreeDict's per-row gender field
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

import glob
import json
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
HAS_WIKT_TARGET_DUMP = {"de", "fr", "it"}

MAX_ALTERNATIVES = 5
MAX_GLOSSES = 2
MIN_INDEPENDENT_VOTES = 2
# Fixed priority order used both for the independent-source vote count and for
# deterministic tie-breaking / display-casing precedence.
SOURCE_ORDER = ["freedict", "apertium", "omw", "entr"]


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

def load_slim_wikt_indexes(lang: str) -> tuple[dict[str, list[tuple[str | None, str | None]]], dict[str, list[str]]]:
    """Returns (noun_morph_idx, glosses_idx). noun_morph_idx only covers `noun`
    rows (gender/plural authority); glosses_idx covers every POS (used for
    target-language definitions of an alternative, regardless of its POS).
    """
    noun_idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    gloss_idx: dict[str, list[str]] = defaultdict(list)
    if lang not in HAS_WIKT_TARGET_DUMP:
        return noun_idx, gloss_idx
    path = WIKT_CACHE_DIR / f"slim-{lang}.jsonl"
    if not path.exists():
        return noun_idx, gloss_idx
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            lemma_key = norm(rec.get("lemma"))
            if not lemma_key:
                continue
            if rec.get("pos") == "noun":
                noun_idx[lemma_key].append((rec.get("gender"), rec.get("plural")))
            for g in rec.get("glosses") or []:
                if g and len(gloss_idx[lemma_key]) < 6:
                    gloss_idx[lemma_key].append(g)
    return noun_idx, gloss_idx


def best_morph(pairs: list[tuple[str | None, str | None]]) -> tuple[str | None, str | None] | None:
    """Most-common (gender, plural) pair with a non-null gender; None if none has one."""
    usable = [(g, p) for g, p in pairs if g]
    if not usable:
        return None
    counts = Counter(usable)
    return counts.most_common(1)[0][0]


# ---------------------------------------------------------------------------
# Per-candidate alternative building
# ---------------------------------------------------------------------------

def build_alternatives_and_check_gate(
    lang: str,
    en_key: str,
    indexes: dict,
) -> tuple[list[dict], set[str], bool]:
    """Returns (alternatives[<=5, best first], all_alt_norm_keys, passes_vote_gate)."""
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
        return [], set(), False

    best_votes = max(len(s) for s in alt_sources.values())
    passes = best_votes >= MIN_INDEPENDENT_VOTES

    noun_idx = indexes["wikt_noun"]
    gloss_idx = indexes["wikt_gloss"]
    wikidata_idx = indexes["wikidata"]

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

        morph = None
        wd_pairs = wikidata_idx.get(cn, [])
        wd_best = best_morph(wd_pairs)
        if wd_best is not None:
            morph = {"gender": wd_best[0], "plural": wd_best[1], "authority": "wikidata"}
        else:
            wx_pairs = noun_idx.get(cn, [])
            wx_best = best_morph(wx_pairs)
            if wx_best is not None:
                morph = {"gender": wx_best[0], "plural": wx_best[1], "authority": "wiktextract"}

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

    return alternatives, set(alt_sources.keys()), passes


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

def run_language(lang: str, universe: list[dict], entr_idx: dict) -> int:
    log(f"=== {lang} ===")
    t0 = time.time()
    pack_keys = load_pack_keys(lang)
    excluded_keys = load_already_adjudicated_keys(lang)
    noun_idx, gloss_idx = load_slim_wikt_indexes(lang)
    indexes = {
        "freedict": load_freedict_index(lang),
        "apertium": load_apertium_index(lang),
        "omw": load_omw_index(lang),
        "entr": entr_idx,
        "wikidata": load_wikidata_index(lang),
        "wikt_noun": noun_idx,
        "wikt_gloss": gloss_idx,
    }
    log(f"  indexes loaded in {time.time() - t0:.1f}s "
        f"(pack_keys={len(pack_keys)}, already_adjudicated={len(excluded_keys)})")

    t1 = time.time()
    records = []
    considered = 0
    for row in universe:
        if lang not in row["missingIn"]:
            continue
        word = row["word"]
        key = norm(word)
        if not key or key in pack_keys or key in excluded_keys:
            continue
        considered += 1

        alternatives, all_alt_keys, passes = build_alternatives_and_check_gate(lang, key, indexes)
        if not passes:
            continue

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
        f">={MIN_INDEPENDENT_VOTES}-source-vote gate in {time.time() - t1:.1f}s -> {out_path}")
    return len(records)


def main() -> None:
    global ES_WIKIDATA_DENYLIST
    ES_WIKIDATA_DENYLIST = load_es_wikidata_denylist()
    log(f"loaded es wikidata contamination denylist: {len(ES_WIKIDATA_DENYLIST)} lemmas")

    langs = sys.argv[1:] or LANGUAGES

    log("loading candidate universe ...")
    t0 = time.time()
    universe = load_universe()
    log(f"  {len(universe)} candidate rows in {time.time() - t0:.1f}s")

    log("loading shared en-tr-cache index ...")
    t0 = time.time()
    entr_idx = load_entr_index()
    log(f"  {len(entr_idx)} keys in {time.time() - t0:.1f}s")

    counts = {}
    for lang in langs:
        counts[lang] = run_language(lang, universe, entr_idx)

    log(f"=== SUMMARY === {json.dumps(counts)}")
    print(json.dumps({"counts": counts, "goldBatches": 0}, indent=2))


if __name__ == "__main__":
    main()
