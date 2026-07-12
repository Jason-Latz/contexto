#!/usr/bin/env python3
"""Build enriched, prioritized LLM-adjudication queues for Contexto pack audit.

Reads (read-only): pack entries under public/language-packs/, the deterministic
evidence merge under pipeline/data/evidence/{lang}-evidence.jsonl (see
merge_evidence.py for how buckets/votes/morphology there were computed), the
raw cross-reference sources under pipeline/data/sources/, the shared English
sense cache pipeline/data/en-tr-cache.jsonl, and the slim target-language
Wiktextract caches pipeline/data/wikt-cache/slim-{de,fr,it}.jsonl (there is no
Spanish target-language Wiktextract dump in this repo -- confirmed by reading
pipeline/data/kaikki.jsonl / freedict_aligned.json / wiktionary_extracted.json,
which all turn out to be stale/mislabeled German data, matching what
merge_evidence.py's docstring already found. So `currentTargetGlosses` and the
wiktextract half of `morph` are always empty/null for es.)

Writes:
  pipeline/data/queues/audit-{lang}.jsonl  -- one enriched record per rendered-
    band pack entry (core+tail), ordered flag-*/ambiguous before confirm/
    no-evidence, then by enZipf descending (most-seen first). Skips any
    (lang,key)/(lang,source) already adjudicated per pipeline/data/verdicts/
    {final,fixup}/*.jsonl|*.json (resume support).
  pipeline/data/queues/gold-queue.jsonl    -- ~400-row blind stratified subset
    of pipeline/data/gold/gold.jsonl (ALL fresh de/fr/it/es rows + a stratified
    es prior-audit sample), enriched IDENTICALLY to the per-lang queues, with
    the gold verdict withheld.
  pipeline/data/queues/gold-answers.jsonl  -- the withheld verdict fields for
    every gold-queue row, joined by (lang, key).

This script only READS pack files; it never writes to public/language-packs/.
"""
from __future__ import annotations

import json
import math
import random
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKS_DIR = REPO_ROOT / "public" / "language-packs"
SOURCES_DIR = REPO_ROOT / "pipeline" / "data" / "sources"
WIKT_CACHE_DIR = REPO_ROOT / "pipeline" / "data" / "wikt-cache"
EVIDENCE_DIR = REPO_ROOT / "pipeline" / "data" / "evidence"
ENTR_CACHE_PATH = REPO_ROOT / "pipeline" / "data" / "en-tr-cache.jsonl"
QUEUES_DIR = REPO_ROOT / "pipeline" / "data" / "queues"
VERDICTS_DIR = REPO_ROOT / "pipeline" / "data" / "verdicts"
GOLD_PATH = REPO_ROOT / "pipeline" / "data" / "gold" / "gold.jsonl"

LANGUAGES = ["de", "fr", "it", "es"]

# Verified against the actual files (same matrix merge_evidence.py verified).
HAS_FREEDICT = {"de", "fr", "it"}
HAS_OMW = {"es", "fr", "it"}
HAS_WIKT_TARGET_DUMP = {"de", "fr", "it"}

# Pack partOfSpeech -> slim-wikt-cache pos abbreviation.
POS_MAP = {"noun": "noun", "verb": "verb", "adjective": "adj", "adverb": "adv"}

# Buckets that need a human/LLM look first: any morphology/retarget flag, or
# genuinely ambiguous evidence. "confirm" and "no-evidence" are lower priority.
BUCKET_PRIORITY_GROUP = {
    "flag-gender": 0,
    "flag-plural": 0,
    "flag-retarget": 0,
    "ambiguous": 0,
    "confirm": 1,
    "no-evidence": 1,
}

# Stratified es prior-audit sample sizes for the gold queue. Not proportional
# to the population (2716 keep / 90 retarget / 385 gate) on purpose: a
# proportional sample would give retarget only ~7 rows, too few to evaluate an
# adjudicator's retarget precision/recall. We take every retarget row (there
# are only 90), a solid chunk of gate, and fill the rest with keep so the
# combined es prior-audit sample is 260 rows. Combined with the 140 fresh
# rows (all of them, across de/fr/it/es) that is exactly 400 gold rows.
ES_PRIOR_AUDIT_STRATA_TARGETS = {"retarget": 90, "gate": 100, "keep": 70}

GOLD_BATCH_SIZE = 45
RANDOM_SEED = 20260712


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Normalization helpers (same rules as merge_evidence.py)
# ---------------------------------------------------------------------------

def norm(s: str | None) -> str:
    if not s:
        return ""
    return " ".join(s.strip().lower().split())


def fold_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def match_kind(current_norm: str, candidate_norm: str) -> str | None:
    if not current_norm or not candidate_norm:
        return None
    if current_norm == candidate_norm:
        return "exact"
    if fold_accents(current_norm) == fold_accents(candidate_norm):
        return "near"
    return None


# ---------------------------------------------------------------------------
# Pack + evidence loading
# ---------------------------------------------------------------------------

def load_pack_entries(lang: str) -> dict[str, dict]:
    """key -> entry dict (with an added "_tier" of "core"/"tail")."""
    out: dict[str, dict] = {}
    for suffix, tier in ((".json", "core"), (".tail.json", "tail")):
        path = PACKS_DIR / f"{lang}{suffix}"
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, entry in data["entries"].items():
            rec = dict(entry)
            rec["_tier"] = tier
            out[key] = rec
    return out


def load_evidence(lang: str) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    path = EVIDENCE_DIR / f"{lang}-evidence.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[r["key"]] = r
    return idx


# ---------------------------------------------------------------------------
# Raw source indexes
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


def load_omw_index(lang: str) -> dict[str, list[tuple[int, str, list[str]]]]:
    """normalize(en) -> list of (senseRank, gloss, targets)."""
    idx: dict[str, list[tuple[int, str, list[str]]]] = defaultdict(list)
    if lang not in HAS_OMW:
        return idx
    path = SOURCES_DIR / f"omw-eng-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("en"))].append(
                (r.get("senseRank") or 999, r.get("gloss") or "", r.get("targets") or [])
            )
    return idx


def load_wikidata_index(lang: str) -> dict[str, list[tuple[str | None, str | None]]]:
    idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    path = SOURCES_DIR / f"wikidata-lexemes-{lang}.jsonl"
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            idx[norm(r.get("lemma"))].append((r.get("gender"), r.get("plural")))
    return idx


def load_entr_buckets() -> dict[str, list[dict]]:
    """normalize(en word) -> list of {pos, gloss, tr:[(lang,target,tags)...]}.

    Shared across all four languages (built once).
    """
    idx: dict[str, list[dict]] = defaultdict(list)
    with open(ENTR_CACHE_PATH, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            tr = [(t[0], t[1], t[2] if len(t) > 2 else []) for t in (r.get("tr") or [])]
            idx[norm(r.get("w"))].append({"pos": r.get("pos"), "gloss": r.get("g") or "", "tr": tr})
    return idx


def load_slim_wikt_index(lang: str) -> dict[str, list[dict]]:
    """normalize(lemma) -> list of {pos, gender, plural, glosses}.

    Reuses the slim cache merge_evidence.py already builds from the raw
    target-language Wiktextract dump. Doesn't have es (no Spanish
    target-language dump exists in this repo).
    """
    idx: dict[str, list[dict]] = defaultdict(list)
    if lang not in HAS_WIKT_TARGET_DUMP:
        return idx
    path = WIKT_CACHE_DIR / f"slim-{lang}.jsonl"
    if not path.exists():
        log(f"WARNING: slim wikt cache missing for {lang}: {path} "
            f"(run merge_evidence.py first) -- currentTargetGlosses/wiktextract "
            f"morph will be empty for {lang}")
        return idx
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            idx[norm(rec["lemma"])].append(rec)
    return idx


def build_wikt_noun_index(wikt_idx: dict[str, list[dict]]) -> dict[str, list[tuple[str | None, str | None]]]:
    idx: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    for lemma_n, recs in wikt_idx.items():
        for rec in recs:
            if rec.get("pos") == "noun" and (rec.get("gender") or rec.get("plural")):
                idx[lemma_n].append((rec.get("gender"), rec.get("plural")))
    return idx


def build_indexes(lang: str, entr_shared: dict[str, list[dict]]) -> dict:
    wikt_idx = load_slim_wikt_index(lang)
    return {
        "freedict": load_freedict_index(lang),
        "apertium": load_apertium_index(lang),
        "omw": load_omw_index(lang),
        "entr": entr_shared,
        "wikidata": load_wikidata_index(lang),
        "wikt": wikt_idx,
        "wikt_noun": build_wikt_noun_index(wikt_idx),
    }


# ---------------------------------------------------------------------------
# Resume support: exclude already-adjudicated identities
# ---------------------------------------------------------------------------

def _iter_records_from_file(path: Path):
    if path.suffix == ".jsonl":
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    else:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if isinstance(data, list):
            yield from data
        elif isinstance(data, dict):
            if "lang" in data and ("key" in data or "source" in data):
                yield data
            else:
                for v in data.values():
                    if isinstance(v, dict):
                        yield v


def load_adjudicated_keys() -> set[tuple[str, str]]:
    excluded: set[tuple[str, str]] = set()
    for sub in ("final", "fixup"):
        d = VERDICTS_DIR / sub
        if not d.exists():
            continue
        for path in sorted(list(d.glob("*.jsonl")) + list(d.glob("*.json"))):
            for r in _iter_records_from_file(path):
                if not isinstance(r, dict):
                    continue
                lang = r.get("lang")
                if not lang:
                    continue
                if r.get("key"):
                    excluded.add((lang, r["key"]))
                if r.get("source"):
                    excluded.add((lang, r["source"]))
                    excluded.add((lang, norm(r["source"])))
    return excluded


# ---------------------------------------------------------------------------
# Per-entry enrichment
# ---------------------------------------------------------------------------

def build_entr_senses(entr_buckets: list[dict], lang: str, target_n: str) -> list[dict]:
    out = []
    seen_glosses: set[str] = set()
    for bucket in entr_buckets:
        gloss = bucket.get("gloss") or ""
        if gloss in seen_glosses:
            continue
        seen_glosses.add(gloss)
        contains = False
        for lc, cand, _tags in bucket.get("tr", []):
            if lc != lang:
                continue
            if match_kind(target_n, norm(cand)) == "exact":
                contains = True
                break
        out.append({"gloss": gloss, "containsCurrent": contains})
        if len(out) >= 10:
            break
    return out


def build_omw_field(omw_rows: list[tuple[int, str, list[str]]]) -> list[dict]:
    if not omw_rows:
        return []
    rows_sorted = sorted(omw_rows, key=lambda r: r[0])[:8]
    return [
        {"senseRank": sense_rank, "gloss": gloss, "targets": targets[:6]}
        for sense_rank, gloss, targets in rows_sorted
    ]


def build_current_target_glosses(target_n: str, pos: str | None, wikt_idx: dict[str, list[dict]]) -> list[str]:
    if not target_n:
        return []
    records = wikt_idx.get(target_n, [])
    if not records:
        return []
    pos_short = POS_MAP.get(pos or "")
    ordered = records
    if pos_short:
        matching = [r for r in records if r.get("pos") == pos_short]
        other = [r for r in records if r.get("pos") != pos_short]
        ordered = matching + other
    glosses: list[str] = []
    for rec in ordered:
        for g in rec.get("glosses") or []:
            if g and g not in glosses:
                glosses.append(g)
            if len(glosses) >= 3:
                return glosses
    return glosses


def build_alternatives(
    current_target_n: str,
    lang: str,
    freedict_targets: list[str],
    apertium_targets: list[str],
    omw_rows: list[tuple[int, str, list[str]]],
    entr_buckets: list[dict],
    wikidata_idx: dict[str, list[tuple[str | None, str | None]]],
    wikt_noun_idx: dict[str, list[tuple[str | None, str | None]]],
) -> list[dict]:
    alt_votes: dict[str, set[str]] = defaultdict(set)
    alt_orig_case: dict[str, str] = {}
    alt_omw_best_rank: dict[str, int] = {}
    alt_glosses: dict[str, list[str]] = defaultdict(list)

    def register(cand_raw: str, source_name: str, sense_rank: int | None = None, gloss: str | None = None) -> None:
        cn = norm(cand_raw)
        if not cn or cn == current_target_n:
            return
        alt_votes[cn].add(source_name)
        alt_orig_case.setdefault(cn, cand_raw.strip())
        if sense_rank is not None:
            if cn not in alt_omw_best_rank or sense_rank < alt_omw_best_rank[cn]:
                alt_omw_best_rank[cn] = sense_rank
        if gloss:
            glist = alt_glosses[cn]
            if gloss not in glist and len(glist) < 2:
                glist.append(gloss)

    if lang in HAS_FREEDICT:
        for t in freedict_targets:
            register(t, "freedict")
    for t in apertium_targets:
        register(t, "apertium")
    if lang in HAS_OMW:
        for sense_rank, gloss, targets in omw_rows:
            for t in targets:
                register(t, "omw", sense_rank, gloss)
    for bucket in entr_buckets:
        gloss = bucket.get("gloss")
        for lc, t, _tags in bucket.get("tr", []):
            if lc == lang:
                register(t, "entr", None, gloss)

    def sort_key(item: tuple[str, set[str]]):
        cn, sources = item
        rank = alt_omw_best_rank.get(cn)
        return (-len(sources), rank if rank is not None else 999)

    ranked = sorted(alt_votes.items(), key=sort_key)[:5]

    result = []
    for cn, sources in ranked:
        gender = plural = None
        authority: list[str] = []

        wd = wikidata_idx.get(cn)
        if wd:
            genders = {g for g, _p in wd if g}
            plurals = {p for _g, p in wd if p}
            if genders:
                gender = sorted(genders)[0]
            if plurals:
                plural = sorted(plurals)[0]
            if genders or plurals:
                authority.append("wikidata")

        wx = wikt_noun_idx.get(cn)
        if wx:
            genders = {g for g, _p in wx if g}
            plurals = {p for _g, p in wx if p}
            if genders and not gender:
                gender = sorted(genders)[0]
            if plurals and not plural:
                plural = sorted(plurals)[0]
            if genders or plurals:
                authority.append("wiktextract")

        morph = {"gender": gender, "plural": plural, "authority": authority or None} if authority else None

        result.append({
            "target": alt_orig_case.get(cn, cn),
            "votes": len(sources),
            "sources": sorted(sources),
            "omwBestSenseRank": alt_omw_best_rank.get(cn),
            "glosses": alt_glosses.get(cn, [])[:2],
            "morph": morph,
        })
    return result


def enrich_entry(lang: str, key: str, entry: dict, evidence_rec: dict | None, indexes: dict) -> dict:
    source = entry.get("source") or key
    target = entry.get("target") or ""
    pos = entry.get("partOfSpeech")
    gender = entry.get("gender")
    plural = entry.get("plural")
    tier = entry.get("_tier")
    en_zipf = entry.get("enZipf")
    bucket = evidence_rec.get("resolution") if evidence_rec else None

    en_key = norm(source) or norm(key)
    target_n = norm(target)

    freedict_targets = indexes["freedict"].get(en_key, [])
    apertium_targets = indexes["apertium"].get(en_key, [])
    omw_rows = indexes["omw"].get(en_key, []) if lang in HAS_OMW else []
    entr_buckets = indexes["entr"].get(en_key, [])

    entr_senses = build_entr_senses(entr_buckets, lang, target_n)
    omw_field = build_omw_field(omw_rows) if lang in HAS_OMW else None
    current_target_glosses = build_current_target_glosses(target_n, pos, indexes["wikt"])
    alternatives = build_alternatives(
        target_n, lang, freedict_targets, apertium_targets, omw_rows, entr_buckets,
        indexes["wikidata"], indexes["wikt_noun"],
    )

    if evidence_rec:
        morphology = evidence_rec.get("morphology") or {}
        morph = {"wikidata": morphology.get("wikidata"), "wiktextract": morphology.get("wiktextract")}
    else:
        morph = {"wikidata": None, "wiktextract": None}

    return {
        "lang": lang,
        "key": key,
        "source": source,
        "target": target,
        "pos": pos,
        "gender": gender,
        "plural": plural,
        "tier": tier,
        "bucket": bucket,
        "enZipf": en_zipf,
        "entrSenses": entr_senses,
        "omw": omw_field,
        "currentTargetGlosses": current_target_glosses,
        "alternatives": alternatives,
        "morph": morph,
    }


# ---------------------------------------------------------------------------
# Per-language audit queue
# ---------------------------------------------------------------------------

def is_rendered_band(entry: dict) -> bool:
    if not entry.get("eligible"):
        return False
    if entry.get("confidence") == "high":
        return True
    z = entry.get("enZipf")
    return z is not None and z < 5


def build_audit_queue_for_lang(
    lang: str, entries: dict[str, dict], evidence: dict[str, dict], indexes: dict,
    adjudicated: set[tuple[str, str]],
) -> dict:
    rows = []
    n_rendered = 0
    n_excluded = 0

    for key, entry in entries.items():
        if not is_rendered_band(entry):
            continue
        n_rendered += 1
        source = entry.get("source") or key
        if (lang, key) in adjudicated or (lang, source) in adjudicated or (lang, norm(source)) in adjudicated:
            n_excluded += 1
            continue
        evidence_rec = evidence.get(key)
        rows.append(enrich_entry(lang, key, entry, evidence_rec, indexes))

    def sort_key(rec: dict):
        group = BUCKET_PRIORITY_GROUP.get(rec["bucket"], 1)
        z = rec["enZipf"] if rec["enZipf"] is not None else 0.0
        return (group, -z)

    rows.sort(key=sort_key)

    out_path = QUEUES_DIR / f"audit-{lang}.jsonl"
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    bucket_counts = Counter(r["bucket"] for r in rows)
    return {
        "totalPackEntries": len(entries),
        "renderedBand": n_rendered,
        "excludedAlreadyAdjudicated": n_excluded,
        "queued": len(rows),
        "bucketCounts": dict(bucket_counts),
    }


# ---------------------------------------------------------------------------
# Gold queue (blind stratified subset of pipeline/data/gold/gold.jsonl)
# ---------------------------------------------------------------------------

def _find_pack_key(entries: dict[str, dict], source: str) -> str | None:
    if source in entries:
        return source
    sn = norm(source)
    for k in entries:
        if norm(k) == sn:
            return k
    return None


def build_gold_queue(all_lang_data: dict[str, tuple[dict, dict, dict]]) -> tuple[list[dict], list[dict]]:
    rows = [json.loads(line) for line in GOLD_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]

    fresh = [r for r in rows if r.get("provenance") == "fresh"]
    es_prior = [r for r in rows if r.get("lang") == "es" and r.get("provenance") == "prior-audit"]

    by_verdict: dict[str, list[dict]] = defaultdict(list)
    for r in es_prior:
        by_verdict[r.get("verdict")].append(r)

    rng = random.Random(RANDOM_SEED)
    sampled_es_prior: list[dict] = []
    for verdict, target_n in ES_PRIOR_AUDIT_STRATA_TARGETS.items():
        pool = sorted(by_verdict.get(verdict, []), key=lambda r: r["source"])
        rng.shuffle(pool)
        sampled_es_prior.extend(pool[:target_n])

    known_verdicts = set(ES_PRIOR_AUDIT_STRATA_TARGETS)
    for v, pool in by_verdict.items():
        if v not in known_verdicts:
            log(f"WARNING: unexpected es prior-audit verdict {v!r} ({len(pool)} rows) not sampled into gold queue")

    selected = fresh + sampled_es_prior
    rng.shuffle(selected)

    queue_rows: list[dict] = []
    answer_rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for r in selected:
        lang = r["lang"]
        source = r["source"]
        entries, evidence, indexes = all_lang_data[lang]
        key = _find_pack_key(entries, source)
        if key is None:
            log(f"WARNING: gold row lang={lang} source={source!r} has no matching pack entry, skipping")
            continue
        if (lang, key) in seen:
            continue
        seen.add((lang, key))

        entry = entries[key]
        evidence_rec = evidence.get(key)
        queue_rows.append(enrich_entry(lang, key, entry, evidence_rec, indexes))
        answer_rows.append({
            "lang": lang,
            "key": key,
            "source": source,
            "verdict": r.get("verdict"),
            "correctedTarget": r.get("correctedTarget"),
            "correctedGender": r.get("correctedGender"),
            "correctedPlural": r.get("correctedPlural"),
            "genderOk": r.get("genderOk"),
            "pluralOk": r.get("pluralOk"),
            "provenance": r.get("provenance"),
            "rationale": r.get("rationale"),
        })

    return queue_rows, answer_rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    QUEUES_DIR.mkdir(parents=True, exist_ok=True)

    adjudicated = load_adjudicated_keys()
    log(f"resume: {len(adjudicated)} already-adjudicated (lang,identity) pairs excluded")

    log("loading shared en-tr-cache index ...")
    t0 = time.time()
    entr_shared = load_entr_buckets()
    log(f"  {len(entr_shared)} keys in {time.time() - t0:.1f}s")

    all_lang_data: dict[str, tuple[dict, dict, dict]] = {}
    summary: dict[str, dict] = {}

    for lang in LANGUAGES:
        t0 = time.time()
        log(f"=== {lang} ===")
        entries = load_pack_entries(lang)
        evidence = load_evidence(lang)
        indexes = build_indexes(lang, entr_shared)
        all_lang_data[lang] = (entries, evidence, indexes)
        counts = build_audit_queue_for_lang(lang, entries, evidence, indexes, adjudicated)
        summary[lang] = counts
        log(f"  {counts} ({time.time() - t0:.1f}s)")

    log("=== gold queue ===")
    t0 = time.time()
    gold_rows, answer_rows = build_gold_queue(all_lang_data)
    with open(QUEUES_DIR / "gold-queue.jsonl", "w", encoding="utf-8") as f:
        for r in gold_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(QUEUES_DIR / "gold-answers.jsonl", "w", encoding="utf-8") as f:
        for r in answer_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"  {len(gold_rows)} gold rows ({time.time() - t0:.1f}s)")

    gold_batches = math.ceil(len(gold_rows) / GOLD_BATCH_SIZE) if gold_rows else 0

    result = {
        "counts": summary,
        "goldQueueRows": len(gold_rows),
        "goldBatches": gold_batches,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
