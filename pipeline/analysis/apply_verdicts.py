#!/usr/bin/env python3
"""Apply LLM adjudication verdicts to the language packs.

This is the SOLE writer of public/language-packs/{lang}.json and
{lang}.tail.json for the overnight vocab-quality run (docs/overnight-2026-07-12/
phase1-adjudication.workflow.js). Every other agent in that run treats the packs
as read-only and only ever writes verdict/queue files for this script to apply.

Inputs (per language):
  pipeline/data/queues/audit-{lang}.jsonl   - existing-entry records with
      {key, source, target, pos, gender, plural, alternatives:[{target,votes,
      sources,omwBestSenseRank,glosses,morph:{gender,plural,authority}|null}], ...}
  pipeline/data/queues/mint-{lang}.jsonl    - new-candidate records with
      {key, source, enZipf, alternatives:[...same shape...], shipTierHint}
  pipeline/data/queues/minttrial-mixed.jsonl - a small stratified trial sample
      drawn from the mint-{lang} queues, same record shape plus a "lang" field
      (de/fr/it/es all mixed + shuffled together in one file). When applying a
      given language, only rows with lang==<language> are in scope.
  pipeline/data/verdicts/final/audit-{lang}-*.jsonl  - adjudicator+refuter output,
      one line per queue record: {key, verdict, newTarget, newGender, newPlural,
      morphAuthority, pos, confidence, reason, refuter?, refuterReason?}
      verdict in {"keep", "retarget", "gate"}.
  pipeline/data/verdicts/final/mint-{lang}-*.jsonl   - same idea: {key, verdict,
      target, shipTier, gender, plural, morphAuthority, pos, confidence, reason,
      refuter?, refuterReason?}. verdict in {"mint", "skip"}.
  pipeline/data/verdicts/final/minttrial-mixed-*.jsonl - same shape as the mint
      verdict files, but keyed against minttrial-mixed.jsonl and mixing rows for
      every language in one file (only this language's rows are applied here).
  pipeline/data/verdicts/fixup/{same basename}       - opus-judge overrides for
      disputed lines ONLY, same record shape (no "refuter" field, adds "judge").
      A fixup row for a key REPLACES the final row for that key before applying.

The minttrial-mixed sample is a panel-verified trial run of the adjudication
engine and takes precedence over the corresponding mint-{lang} batch verdict
for any key sampled into both (dedupe by key, minttrial wins): minttrial rows
are applied to the packs BEFORE the plain mint-{lang} batches, and every key
minttrial covers for this language is then excluded outright from the plain
mint-{lang} pass (win, lose, or minttrial-skip -- the trial verdict is final
either way, so a later mint-{lang} "mint" can never sneak in a key minttrial
deliberately skipped). Because minttrial-mixed-* files are shared across all
four languages, their applied/ markers are suffixed with the language
(minttrial-mixed-N.jsonl.<lang>.done) so parallel per-language runs don't
collide or skip each other's share of the file.

Ground truth for morphology and target provenance is always re-derived from the
QUEUE record, never trusted from the verdict payload alone (defense in depth --
"You never invent a translation" / "gender-plural come ONLY from queue morph
fields" are prompt rules, not code guarantees, so the code re-checks them):
  - retarget/mint targets must appear among that key's queue `alternatives`.
  - noun gender/plural come from the matched alternative's `morph` field; if it
    is missing or incomplete the row is downgraded (audit -> gate, mint -> skip)
    regardless of what the verdict claims.

Invariants enforced in-code before anything is written (violations reject the
row, are counted, and are logged -- they never raise and abort the whole run):
  key == source.lower(); gender in the per-language allowed set; target/plural
  are standalone (non-empty, no leading/trailing '-'); core/tail keys stay
  disjoint; tail frequencyRanks stay unique (assigned by continuing the current
  max); no duplicate keys; nouns always carry gender+plural, non-nouns never do.

Idempotent: after a final verdict file (audit or mint, one language) is fully
applied, a marker pipeline/data/verdicts/applied/<basename>.done is written.
Files with an existing marker are skipped on the next invocation, so re-running
this script (e.g. after a later batch of verdicts lands) only applies new work.

Usage:
    python3 pipeline/analysis/apply_verdicts.py --language de
    python3 pipeline/analysis/apply_verdicts.py --language de --mint-only --ship-stratum strict
    python3 pipeline/analysis/apply_verdicts.py --language de --data-root /tmp/fixture
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Mirrors GENDERS_BY_LANGUAGE in scripts/validate-language-packs.mjs and
# src/language/registry.ts. German adds neuter; the romance languages don't.
GENDERS_BY_LANGUAGE = {
    "es": {"masculine", "feminine"},
    "fr": {"masculine", "feminine"},
    "it": {"masculine", "feminine"},
    "de": {"masculine", "feminine", "neuter"},
}
DISPLAY_NAME = {"es": "Spanish", "de": "German", "fr": "French", "it": "Italian"}
CONTENT_POS = {"noun", "verb", "adjective", "adverb", "expression"}
NOUN = "noun"

# New tail entries are ranked after every existing tail entry (and after core,
# since core tops out far below this) so freqScore stays ~0 for tail words and
# ranks stay unique within the shard. Mirrors pipeline/import_tail/build.py.
TAIL_RANK_FLOOR = 1_000_000

FINAL_DIR_NAME = "final"
FIXUP_DIR_NAME = "fixup"
APPLIED_DIR_NAME = "applied"

# The trial sample mixes all four languages into one queue/verdict file; it is
# not suffixed per-language like mint-{lang}.jsonl / mint-{lang}-*.jsonl are.
MINTTRIAL_BASENAME = "minttrial-mixed"

_INDEX_RE = re.compile(r"-(\d+)\.jsonl$")


def _paths(root: Path) -> dict[str, Path]:
    packs = root / "public" / "language-packs"
    verdicts = root / "pipeline" / "data" / "verdicts"
    return {
        "packs": packs,
        "queues": root / "pipeline" / "data" / "queues",
        "final": verdicts / FINAL_DIR_NAME,
        "fixup": verdicts / FIXUP_DIR_NAME,
        "applied": verdicts / APPLIED_DIR_NAME,
    }


class Stats:
    """Simple named counter, printed at the end so every reject is visible."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def bump(self, name: str, n: int = 1) -> None:
        self.counts[name] = self.counts.get(name, 0) + n


def reject(stats: Stats, category: str, key: str, reason: str) -> None:
    stats.bump(category)
    print(f"  REJECT [{category}] {key}: {reason}", file=sys.stderr)


def is_standalone(value) -> bool:
    """A real, usable replacement string: non-empty and not a prefix/suffix
    inflection marker (mirrors requireStandaloneTarget in validate-language-packs.mjs)."""
    return isinstance(value, str) and value.strip() != "" and not value.startswith("-") and not value.endswith("-")


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def write_json_pack(path: Path, pack: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def empty_pack(language: str) -> dict:
    return {
        "version": "adjudication",
        "sourceLanguage": "en",
        "targetLanguage": language,
        "displayName": DISPLAY_NAME.get(language, language),
        "sources": {},
        "entries": {},
    }


def load_queue(paths: dict[str, Path], kind: str, language: str) -> dict[str, dict]:
    rows = load_jsonl(paths["queues"] / f"{kind}-{language}.jsonl")
    return {row["key"]: row for row in rows if "key" in row}


def load_minttrial_queue(paths: dict[str, Path], language: str) -> dict[str, dict]:
    """The mixed trial-sample queue, filtered down to this language's rows."""
    rows = load_jsonl(paths["queues"] / f"{MINTTRIAL_BASENAME}.jsonl")
    return {row["key"]: row for row in rows if "key" in row and row.get("lang") == language}


def ship_stratum_ok(row: dict) -> bool:
    """Strict ship-stratum gate: a change (retarget/gate/mint) only ships when
    it was refuter-confirmed or judge-ruled (a fixup row, which carries
    "judge" instead of "refuter"), AND its confidence is >=0.8. This is
    re-derived from the row itself, never trusted from a "ships" flag some
    upstream agent could set -- same defense-in-depth spirit as the
    provenance/morphology re-checks elsewhere in this file."""
    confidence = row.get("confidence")
    if not isinstance(confidence, (int, float)) or confidence < 0.8:
        return False
    if row.get("refuter") == "agree":
        return True
    return bool(row.get("judge"))


def find_alternative(record: dict | None, target) -> dict | None:
    if not record or not isinstance(target, str):
        return None
    for alt in record.get("alternatives") or []:
        if alt.get("target") == target:
            return alt
    return None


def _sorted_by_index(files) -> list[Path]:
    def index_of(p: Path) -> int:
        m = _INDEX_RE.search(p.name)
        return int(m.group(1)) if m else 0

    return sorted(files, key=index_of)


def verdict_files_for(paths: dict[str, Path], kind: str, language: str) -> list[Path]:
    return _sorted_by_index(paths["final"].glob(f"{kind}-{language}-*.jsonl"))


def minttrial_verdict_files(paths: dict[str, Path]) -> list[Path]:
    """Shared across all languages -- callers must restrict rows by key to
    the language they're applying (see load_minttrial_queue)."""
    return _sorted_by_index(paths["final"].glob(f"{MINTTRIAL_BASENAME}-*.jsonl"))


def effective_rows(final_path: Path, paths: dict[str, Path]) -> list[dict]:
    """Final-file rows with any matching fixup (judge) rulings substituted in,
    keyed by `key` -- "fixup wins" per the contract."""
    final_rows = load_jsonl(final_path)
    fixup_rows = load_jsonl(paths["fixup"] / final_path.name)
    fixup_by_key = {row["key"]: row for row in fixup_rows if "key" in row}
    return [fixup_by_key.get(row.get("key"), row) for row in final_rows]


# --------------------------------------------------------------------------
# Audit application: keep (no-op) / gate (eligible:false) / retarget.
# --------------------------------------------------------------------------

def find_entry(core_entries: dict, tail_entries: dict, key: str):
    if key in core_entries:
        return core_entries[key]
    if key in tail_entries:
        return tail_entries[key]
    return None


def apply_audit_row(core_entries: dict, tail_entries: dict, row: dict,
                     queue_by_key: dict, language: str, stats: Stats,
                     ship_stratum: str | None = None) -> None:
    key = row.get("key")
    verdict = row.get("verdict")
    entry = find_entry(core_entries, tail_entries, key)
    if entry is None:
        reject(stats, "audit_missing_entry", key, "key not found in core or tail")
        return

    if ship_stratum == "strict" and verdict != "keep" and not ship_stratum_ok(row):
        # Doesn't clear the ship-stratum bar -- no-op, exactly as "keep" would be.
        stats.bump("audit_shipstratum_noop")
        return

    if verdict == "keep":
        stats.bump("audit_keep")
        return

    if verdict == "gate":
        entry["eligible"] = False
        stats.bump("audit_gate")
        return

    if verdict != "retarget":
        reject(stats, "audit_unknown_verdict", key, f"unrecognized verdict {verdict!r}")
        return

    new_target = row.get("newTarget")
    record = queue_by_key.get(key)
    alt = find_alternative(record, new_target)
    if alt is None:
        # Provenance failure: the proposed target isn't one of the queue's
        # sourced alternatives. Downgrade to gate rather than trust it.
        entry["eligible"] = False
        reject(stats, "audit_retarget_no_provenance", key,
               f"newTarget {new_target!r} not in queue alternatives")
        return
    if not is_standalone(new_target):
        entry["eligible"] = False
        reject(stats, "audit_retarget_bad_target", key, "newTarget not standalone")
        return

    pos = row.get("pos") or entry.get("partOfSpeech")
    if pos not in CONTENT_POS:
        entry["eligible"] = False
        reject(stats, "audit_retarget_bad_pos", key, f"pos {pos!r} not applicable")
        return

    if pos == NOUN:
        morph = alt.get("morph") or {}
        gender = morph.get("gender")
        plural = morph.get("plural")
        allowed = GENDERS_BY_LANGUAGE.get(language, set())
        if gender not in allowed or not is_standalone(plural):
            # "authoritative gender+plural present" failed -> downgrade to gate.
            entry["eligible"] = False
            reject(stats, "audit_retarget_no_morph", key,
                   "noun target has no authoritative gender+plural in the queue")
            return
        entry["gender"] = gender
        entry["plural"] = plural
    else:
        entry.pop("gender", None)
        entry.pop("plural", None)

    entry["target"] = new_target
    entry["partOfSpeech"] = pos
    entry["eligible"] = True
    stats.bump("audit_retarget")


# --------------------------------------------------------------------------
# Mint application: skip (no-op) / mint -> new core or tail entry / drop.
# --------------------------------------------------------------------------

def apply_mint_row(core_entries: dict, tail_entries: dict, row: dict, queue_by_key: dict,
                    language: str, stats: Stats, rank_state: dict,
                    ship_stratum: str | None = None) -> None:
    key = row.get("key")
    verdict = row.get("verdict")

    if ship_stratum == "strict" and verdict != "skip" and not ship_stratum_ok(row):
        # Doesn't clear the ship-stratum bar -- no-op, exactly as "skip" would be.
        stats.bump("mint_shipstratum_noop")
        return

    if verdict == "skip":
        stats.bump("mint_skip")
        return
    if verdict != "mint":
        reject(stats, "mint_unknown_verdict", key, f"unrecognized verdict {verdict!r}")
        return

    if key in core_entries or key in tail_entries:
        reject(stats, "mint_duplicate_key", key, "key already exists in core or tail")
        return

    record = queue_by_key.get(key)
    if record is None:
        reject(stats, "mint_no_queue_record", key, "no matching mint queue record")
        return

    target = row.get("target")
    alt = find_alternative(record, target)
    if alt is None or not is_standalone(target):
        # Never invent a translation: the target must be one of the queue's
        # sourced alternatives.
        reject(stats, "mint_no_provenance", key, f"target {target!r} not in queue alternatives")
        return

    source = record.get("source") or key
    if key != source.strip().lower():
        reject(stats, "mint_key_source_mismatch", key, f"key != source.lower() ({source!r})")
        return

    pos = row.get("pos")
    if pos not in CONTENT_POS:
        reject(stats, "mint_bad_pos", key, f"pos {pos!r} not applicable")
        return

    gender = plural = None
    if pos == NOUN:
        morph = alt.get("morph") or {}
        gender = morph.get("gender")
        plural = morph.get("plural")
        allowed = GENDERS_BY_LANGUAGE.get(language, set())
        if gender not in allowed or not is_standalone(plural):
            reject(stats, "mint_no_morph", key,
                   "noun target has no authoritative gender+plural in the queue")
            return

    source_ids = sorted({s for s in (alt.get("sources") or []) if isinstance(s, str) and s})
    if not source_ids:
        reject(stats, "mint_no_source_ids", key, "no real dictionary sources listed")
        return

    glosses = alt.get("glosses") or []
    source_gloss = glosses[0] if glosses else source
    en_zipf = record.get("enZipf")
    ship_tier = row.get("shipTier")
    confidence = row.get("confidence")
    votes = alt.get("votes") or 0
    # "Unanimous" = no OTHER candidate target for this key drew any votes.
    competing_votes = sum(
        (a.get("votes") or 0) for a in (record.get("alternatives") or [])
        if a is not alt and a.get("target") != target
    )
    unanimous = competing_votes == 0 and votes >= 3

    def make_entry(confidence_tier: str, rank: int) -> dict:
        entry = {
            "source": source,
            "target": target,
            "partOfSpeech": pos,
            "sourceGloss": source_gloss,
            "frequencyRank": rank,
            "confidence": confidence_tier,
            "sourceIds": source_ids,
        }
        if pos == NOUN:
            entry["gender"] = gender
            entry["plural"] = plural
        return entry

    if ship_tier == "core-gap":
        if unanimous and isinstance(confidence, (int, float)) and confidence >= 0.9:
            rank_state["core"] += 1
            core_entries[key] = make_entry("high", rank_state["core"])
            stats.bump("mint_core_gap")
            return
        # Falls back to tail if it's still niche vocabulary; otherwise dropped.
        if isinstance(en_zipf, (int, float)) and en_zipf < 5.0:
            rank_state["tail"] += 1
            entry = make_entry("low", rank_state["tail"])
            entry["enZipf"] = en_zipf
            entry["eligible"] = True
            tail_entries[key] = entry
            stats.bump("mint_core_gap_downgraded_tail")
            return
        reject(stats, "mint_core_gap_dropped", key,
               "not unanimous/confident enough for core and not niche enough for tail")
        return

    if ship_tier == "tail":
        rank_state["tail"] += 1
        entry = make_entry("low", rank_state["tail"])
        entry["enZipf"] = en_zipf if isinstance(en_zipf, (int, float)) else 0
        entry["eligible"] = True
        tail_entries[key] = entry
        stats.bump("mint_tail")
        return

    reject(stats, "mint_unknown_ship_tier", key, f"unrecognized shipTier {ship_tier!r}")


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def apply_language(language: str, root: Path = REPO_ROOT, ship_stratum: str | None = None,
                   mint_only: bool = False) -> dict:
    if language not in GENDERS_BY_LANGUAGE:
        return {"ok": False, "language": language, "notes": f"unsupported language {language!r}"}

    paths = _paths(root)
    core_path = paths["packs"] / f"{language}.json"
    tail_path = paths["packs"] / f"{language}.tail.json"

    core_pack = load_json(core_path)
    if core_pack is None:
        return {"ok": False, "language": language, "notes": f"core pack not found: {core_path}"}
    tail_pack = load_json(tail_path) or empty_pack(language)

    core_entries = core_pack.setdefault("entries", {})
    tail_entries = tail_pack.setdefault("entries", {})

    rank_state = {
        "core": max([e["frequencyRank"] for e in core_entries.values()], default=0),
        "tail": max([e["frequencyRank"] for e in tail_entries.values()], default=TAIL_RANK_FLOOR - 1),
    }

    audit_queue = load_queue(paths, "audit", language)
    mint_queue = load_queue(paths, "mint", language)
    minttrial_queue = load_minttrial_queue(paths, language)

    applied_dir = paths["applied"]
    applied_dir.mkdir(parents=True, exist_ok=True)

    stats = Stats()
    applied_markers: list[str] = []
    applied_files: list[str] = []
    already_applied: list[str] = []

    def process(final_paths: list[Path], queue_by_key: dict, apply_row,
                lang_suffix: str | None = None, restrict_keys: set | None = None,
                exclude_keys: set | None = None) -> None:
        for final_path in final_paths:
            marker_name = (f"{final_path.name}.{lang_suffix}.done" if lang_suffix
                           else f"{final_path.name}.done")
            marker = applied_dir / marker_name
            if marker.exists():
                already_applied.append(marker_name)
                continue
            for row in effective_rows(final_path, paths):
                key = row.get("key")
                if restrict_keys is not None and key not in restrict_keys:
                    continue  # belongs to a different language sampled into this shared file
                if exclude_keys is not None and key in exclude_keys:
                    # Panel-verified minttrial verdict for this key wins outright
                    # (mint OR skip) -- never let the plain mint-{lang} verdict
                    # for the same key apply, even if minttrial itself skipped it.
                    stats.bump("mint_superseded_by_minttrial")
                    continue
                apply_row(row, queue_by_key)
            applied_files.append(final_path.name)
            applied_markers.append(marker_name)

    if not mint_only:
        process(verdict_files_for(paths, "audit", language), audit_queue,
                lambda row, q: apply_audit_row(core_entries, tail_entries, row, q, language, stats, ship_stratum))

    # Minttrial (panel-verified) applies BEFORE the plain mint batches, and the
    # plain mint pass excludes every key minttrial covered -- so for any key
    # sampled into both, the trial verdict (mint OR skip) is the one that
    # counts, never the plain mint-{lang} engine's verdict for that same key.
    process(minttrial_verdict_files(paths), minttrial_queue,
            lambda row, q: apply_mint_row(core_entries, tail_entries, row, q, language, stats, rank_state, ship_stratum),
            lang_suffix=language, restrict_keys=set(minttrial_queue))
    process(verdict_files_for(paths, "mint", language), mint_queue,
            lambda row, q: apply_mint_row(core_entries, tail_entries, row, q, language, stats, rank_state, ship_stratum),
            exclude_keys=set(minttrial_queue))

    if applied_markers:
        write_json_pack(core_path, core_pack)
        write_json_pack(tail_path, tail_pack)
        for name in applied_markers:
            (applied_dir / name).write_text("", encoding="utf-8")

    return {
        "ok": True,
        "language": language,
        "applied": len(applied_markers),
        "skippedAlreadyApplied": len(already_applied),
        "appliedFiles": applied_files,
        "alreadyAppliedFiles": already_applied,
        "counts": stats.counts,
        "coreEntries": len(core_entries),
        "tailEntries": len(tail_entries),
        "notes": f"{len(applied_markers)} verdict file(s) applied, {len(already_applied)} already-applied skipped",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--language", required=True, choices=sorted(GENDERS_BY_LANGUAGE))
    parser.add_argument("--data-root", type=Path, default=None,
                         help="override the repo root (used by the self-test)")
    parser.add_argument("--ship-stratum", choices=["strict"], default=None,
                         help="strict: only apply retarget/gate/mint rows that are "
                              "refuter-agreed or judge-ruled AND confidence>=0.8; "
                              "everything else no-ops as keep/skip")
    parser.add_argument("--mint-only", action="store_true",
                         help="apply only mint-{language}-*.jsonl and this language's "
                              "rows of minttrial-mixed-*.jsonl; never touch audit-*.jsonl")
    args = parser.parse_args(argv)

    report = apply_language(args.language, args.data_root or REPO_ROOT, args.ship_stratum, args.mint_only)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
