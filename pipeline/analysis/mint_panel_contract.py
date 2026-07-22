#!/usr/bin/env python3
"""Deterministic mint-panel sampling, reduction, and apply preflight.

The fluent-speaker panel still supplies the semantic judgments. Everything
that decides *which* pending mints were reviewed and whether its verdict may
authorize a pack write lives here, in tracked code:

* validate the frozen ordered queue against the canonical queue;
* require every expected pending batch to have an exact final + fixups;
* derive the effective strict-mint universe with applied batches excluded;
* fingerprint the complete queue+verdict inputs, not a lossy key list;
* draw a deterministic evidence-stratified sample;
* reduce one exact judgment per sampled key and retain every false key; and
* validate a panel verdict immediately before apply.

CLI examples:

    python3 -m pipeline.analysis.mint_panel_contract sample \
      --language de --seed 20260720 --sample-size 120 --output /tmp/de-sample.jsonl

    python3 -m pipeline.analysis.mint_panel_contract reduce \
      --language de --seed 20260720 --sample-size 120 \
      --results /tmp/de-agent-0.jsonl --results /tmp/de-agent-1.jsonl \
      --output /tmp/panel-de-20260720.json

    python3 -m pipeline.analysis.mint_panel_contract validate \
      --language de --panel-verdict /tmp/panel-de-20260720.json

This module never writes language packs or applied markers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = {"de", "es", "fr", "it"}
SCHEMA_VERSION = 1
DEFAULT_BATCH_SIZE = 100
DEFAULT_FILE_INDEX_BASE = 10_000
DEFAULT_SHIP_BAR = 0.05

class PanelContractError(ValueError):
    """A fail-closed panel/universe integrity failure."""


@dataclass(frozen=True)
class PendingMintUniverse:
    language: str
    rows: tuple[dict, ...]
    fingerprint: str
    pending_files: tuple[str, ...]
    applied_files: tuple[str, ...]

    @property
    def eligible(self) -> int:
        return len(self.rows)

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(row["verdict"]["key"] for row in self.rows)


@dataclass(frozen=True)
class PanelAuthorization:
    panel_path: Path
    false_keys: frozenset[str]
    universe_fingerprint: str
    sample_fingerprint: str
    sampled: int
    errors: int


def ship_stratum_ok(row: dict) -> bool:
    """The one strict-mint eligibility predicate shared with the applier."""
    confidence = row.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        return False
    if not math.isfinite(float(confidence)) or confidence < 0.8:
        return False
    judge = row.get("judge")
    return row.get("refuter") == "agree" or (
        isinstance(judge, str) and bool(judge.strip())
    )


def _canonical_bytes(value) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _fingerprint(value) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _duplicate_rejecting_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PanelContractError(f"duplicate JSON field {key!r}")
        result[key] = value
    return result


def _reject_nonfinite_json(value: str):
    raise PanelContractError(f"non-finite JSON number {value!r}")


def load_json_strict(path: Path):
    if not path.exists():
        raise PanelContractError(f"missing JSON file: {path}")
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_duplicate_rejecting_object,
            parse_constant=_reject_nonfinite_json,
        )
    except PanelContractError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise PanelContractError(f"invalid JSON file {path}: {exc}") from exc


def load_jsonl_strict(path: Path, *, allow_missing: bool = False) -> list[dict]:
    if not path.exists():
        if allow_missing:
            return []
        raise PanelContractError(f"missing JSONL file: {path}")
    rows: list[dict] = []
    try:
        for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not raw.strip():
                continue
            try:
                row = json.loads(
                    raw,
                    object_pairs_hook=_duplicate_rejecting_object,
                    parse_constant=_reject_nonfinite_json,
                )
            except (PanelContractError, json.JSONDecodeError) as exc:
                raise PanelContractError(
                    f"invalid JSONL row {path}:{line_number}: {exc}"
                ) from exc
            if not isinstance(row, dict):
                raise PanelContractError(f"non-object JSONL row {path}:{line_number}")
            rows.append(row)
    except OSError as exc:
        raise PanelContractError(f"cannot read {path}: {exc}") from exc
    return rows


def _unique_by_key(rows: Iterable[dict], *, label: str) -> dict[str, dict]:
    indexed: dict[str, dict] = {}
    for row in rows:
        key = row.get("key")
        if not isinstance(key, str) or not key:
            raise PanelContractError(f"{label} has a row without a non-empty key")
        if key in indexed:
            raise PanelContractError(f"{label} has duplicate key {key!r}")
        indexed[key] = row
    return indexed


def _verdict_paths(root: Path) -> dict[str, Path]:
    verdicts = root / "pipeline" / "data" / "verdicts"
    return {
        "queues": root / "pipeline" / "data" / "queues",
        "final": verdicts / "final",
        "fixup": verdicts / "fixup",
        "applied": verdicts / "applied",
    }


def _validate_effective_batch(
    final_path: Path,
    fixup_path: Path,
    expected_rows: list[dict],
) -> list[dict]:
    expected = _unique_by_key(expected_rows, label=f"ordered slice for {final_path.name}")
    final_rows = load_jsonl_strict(final_path)
    final = _unique_by_key(final_rows, label=final_path.name)
    if set(final) != set(expected):
        missing = sorted(set(expected) - set(final))[:10]
        foreign = sorted(set(final) - set(expected))[:10]
        raise PanelContractError(
            f"{final_path.name} does not exactly cover its ordered slice "
            f"(missing={missing}, foreign={foreign})"
        )

    for key, row in final.items():
        if "judge" in row:
            raise PanelContractError(
                f"{final_path.name} key {key!r} illegally carries judge authority"
            )
        refuter = row.get("refuter")
        if refuter not in {"agree", "dispute", "unreviewed"}:
            raise PanelContractError(
                f"{final_path.name} key {key!r} has invalid refuter state {refuter!r}"
            )
        if refuter == "dispute":
            reason = row.get("refuterReason")
            if not isinstance(reason, str) or not reason.strip():
                raise PanelContractError(
                    f"{final_path.name} key {key!r} dispute lacks a reason"
                )

    disputed = {key for key, row in final.items() if row.get("refuter") == "dispute"}
    fixup_rows = load_jsonl_strict(fixup_path, allow_missing=True)
    fixups = _unique_by_key(fixup_rows, label=fixup_path.name)
    if set(fixups) != disputed:
        missing = sorted(disputed - set(fixups))[:10]
        foreign = sorted(set(fixups) - disputed)[:10]
        raise PanelContractError(
            f"{fixup_path.name} does not exactly rule every disputed key "
            f"(missing={missing}, foreign={foreign})"
        )
    for key, row in fixups.items():
        judge = row.get("judge")
        if not isinstance(judge, str) or not judge.strip():
            raise PanelContractError(f"{fixup_path.name} key {key!r} lacks judge authority")
        if "refuter" in row or "refuterReason" in row:
            raise PanelContractError(
                f"{fixup_path.name} key {key!r} illegally carries refuter authority"
            )

    return [fixups.get(row["key"], final[row["key"]]) for row in expected_rows]


def _pending_minttrial_rows(
    paths: dict[str, Path], language: str
) -> tuple[list[dict], set[str], list[str], list[str]]:
    queue_path = paths["queues"] / "minttrial-mixed.jsonl"
    queue_rows = load_jsonl_strict(queue_path, allow_missing=True)
    language_queue = [row for row in queue_rows if row.get("lang") == language]
    queue_by_key = _unique_by_key(language_queue, label=f"minttrial queue for {language}")
    covered_keys = set(queue_by_key)
    universe_rows: list[dict] = []
    pending_files: list[str] = []
    applied_files: list[str] = []
    seen_keys: set[str] = set()

    for final_path in sorted(paths["final"].glob("minttrial-mixed-*.jsonl")):
        marker = paths["applied"] / f"{final_path.name}.{language}.done"
        if marker.exists():
            applied_files.append(final_path.name)
            continue
        all_final = load_jsonl_strict(final_path)
        in_scope = [row for row in all_final if row.get("key") in queue_by_key]
        if not in_scope:
            continue
        final = _unique_by_key(in_scope, label=f"{final_path.name} ({language})")
        duplicate_across_files = seen_keys & set(final)
        if duplicate_across_files:
            raise PanelContractError(
                f"pending minttrial keys repeated across files: {sorted(duplicate_across_files)[:10]}"
            )
        seen_keys.update(final)
        for key, row in final.items():
            if "judge" in row:
                raise PanelContractError(
                    f"{final_path.name} key {key!r} illegally carries judge authority"
                )
            refuter = row.get("refuter")
            if refuter not in {"agree", "dispute", "unreviewed"}:
                raise PanelContractError(
                    f"{final_path.name} key {key!r} has invalid refuter state {refuter!r}"
                )
            if refuter == "dispute":
                reason = row.get("refuterReason")
                if not isinstance(reason, str) or not reason.strip():
                    raise PanelContractError(
                        f"{final_path.name} key {key!r} dispute lacks a reason"
                    )
        fixup_path = paths["fixup"] / final_path.name
        all_fixup = load_jsonl_strict(fixup_path, allow_missing=True)
        fixup_scope = [row for row in all_fixup if row.get("key") in final]
        fixups = _unique_by_key(fixup_scope, label=f"{fixup_path.name} ({language})")
        disputed = {key for key, row in final.items() if row.get("refuter") == "dispute"}
        if set(fixups) != disputed:
            raise PanelContractError(
                f"{fixup_path.name} does not exactly rule pending {language} minttrial disputes"
            )
        for key, row in fixups.items():
            judge = row.get("judge")
            if not isinstance(judge, str) or not judge.strip():
                raise PanelContractError(f"{fixup_path.name} key {key!r} lacks judge authority")
            if "refuter" in row or "refuterReason" in row:
                raise PanelContractError(
                    f"{fixup_path.name} key {key!r} illegally carries refuter authority"
                )
        pending_files.append(final_path.name)
        for key, final_row in final.items():
            effective = fixups.get(key, final_row)
            if effective.get("verdict") == "mint" and ship_stratum_ok(effective):
                universe_rows.append({
                    "origin": {"kind": "minttrial", "file": final_path.name},
                    "queue": queue_by_key[key],
                    "verdict": effective,
                })
    return universe_rows, covered_keys, pending_files, applied_files


def compute_pending_strict_mint_universe(
    root: Path,
    language: str,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    file_index_base: int = DEFAULT_FILE_INDEX_BASE,
) -> PendingMintUniverse:
    """Recompute the exact pending universe the strict mint applier can change."""
    if language not in LANGUAGES:
        raise PanelContractError(f"unsupported panel language {language!r}")
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size <= 0:
        raise PanelContractError("batch_size must be a positive integer")
    if not isinstance(file_index_base, int) or isinstance(file_index_base, bool):
        raise PanelContractError("file_index_base must be an integer")

    root = Path(root)
    paths = _verdict_paths(root)
    canonical_path = paths["queues"] / f"mint-{language}.jsonl"
    ordered_path = paths["queues"] / f"mint-{language}.ordered.jsonl"
    canonical_rows = load_jsonl_strict(canonical_path)
    canonical = _unique_by_key(canonical_rows, label=canonical_path.name)
    ordered_rows = load_jsonl_strict(ordered_path)
    if not ordered_rows:
        raise PanelContractError(f"ordered mint queue is empty: {ordered_path}")
    _unique_by_key(ordered_rows, label=ordered_path.name)
    for row in ordered_rows:
        key = row["key"]
        if key not in canonical:
            raise PanelContractError(f"ordered queue key {key!r} is absent from canonical queue")
        if row != canonical[key]:
            raise PanelContractError(
                f"ordered queue row {key!r} drifted from canonical mint queue"
            )

    trial_rows, trial_keys, pending_files, applied_files = _pending_minttrial_rows(
        paths, language
    )
    universe_rows = list(trial_rows)
    expected_final_names: set[str] = set()

    for logical_index, start in enumerate(range(0, len(ordered_rows), batch_size)):
        file_index = file_index_base + logical_index
        final_name = f"mint-{language}-{file_index}.jsonl"
        expected_final_names.add(final_name)
        marker = paths["applied"] / f"{final_name}.done"
        if marker.exists():
            applied_files.append(final_name)
            continue
        final_path = paths["final"] / final_name
        fixup_path = paths["fixup"] / final_name
        ordered_slice = ordered_rows[start:start + batch_size]
        effective_rows = _validate_effective_batch(final_path, fixup_path, ordered_slice)
        pending_files.append(final_name)
        for queue_row, effective in zip(ordered_slice, effective_rows):
            key = effective["key"]
            if key in trial_keys:
                continue  # minttrial wins outright in apply_verdicts.py
            if effective.get("verdict") == "mint" and ship_stratum_ok(effective):
                universe_rows.append({
                    "origin": {
                        "kind": "mint",
                        "file": final_name,
                        "fileIndex": file_index,
                    },
                    "queue": queue_row,
                    "verdict": effective,
                })

    # apply_verdicts globs every mint-L-*.jsonl file. An unmarked extra final
    # outside the frozen ordered mapping would otherwise bypass this panel.
    for final_path in paths["final"].glob(f"mint-{language}-*.jsonl"):
        marker = paths["applied"] / f"{final_path.name}.done"
        if marker.exists() or final_path.name in expected_final_names:
            continue
        raise PanelContractError(
            f"unmapped pending mint verdict file would bypass panel: {final_path.name}"
        )

    universe_rows.sort(
        key=lambda item: (
            item["verdict"]["key"],
            item["origin"]["kind"],
            item["origin"]["file"],
        )
    )
    keys = [item["verdict"]["key"] for item in universe_rows]
    if len(keys) != len(set(keys)):
        duplicates = sorted(key for key in set(keys) if keys.count(key) > 1)
        raise PanelContractError(f"pending strict-mint universe has duplicate keys: {duplicates[:10]}")
    fingerprint = _fingerprint(universe_rows)
    return PendingMintUniverse(
        language=language,
        rows=tuple(universe_rows),
        fingerprint=fingerprint,
        pending_files=tuple(sorted(pending_files)),
        applied_files=tuple(sorted(applied_files)),
    )


def evidence_bucket(item: dict) -> int:
    """Mirror the mint workflow's seven evidence-priority strata."""
    queue = item["queue"]
    alternatives = queue.get("alternatives") or []
    best_votes = max((alt.get("votes") or 1 for alt in alternatives), default=1)
    tier = queue.get("evidenceTier")
    all_sources = {
        source
        for alt in alternatives
        for source in (alt.get("sources") or [])
        if isinstance(source, str)
    }
    wiki_involved = tier in {"T1", "T2", "T3"} or "wikipedia" in all_sources
    wiktinv_only = bool(all_sources) and all_sources <= {"wiktinv"}
    source_pos = queue.get("sourcePos") or queue.get("pos")
    if not wiki_involved and best_votes >= 2:
        return 0
    if tier == "T1":
        return 1
    if not wiki_involved and best_votes == 1:
        return 2
    if tier == "T2":
        return 3
    if wiktinv_only:
        return 4
    if tier == "T3" and source_pos != "noun":
        return 5
    return 6


def deterministic_sample(
    universe: PendingMintUniverse,
    *,
    sample_size: int,
    seed: int,
) -> tuple[list[dict], dict[str, int]]:
    if not isinstance(sample_size, int) or isinstance(sample_size, bool) or sample_size <= 0:
        raise PanelContractError("sample_size must be a positive integer")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise PanelContractError("seed must be an integer")
    if universe.eligible == 0:
        raise PanelContractError("pending strict-mint universe is empty")

    take = min(sample_size, universe.eligible)
    grouped: dict[int, list[dict]] = defaultdict(list)
    for item in universe.rows:
        grouped[evidence_bucket(item)].append(item)
    for rows in grouped.values():
        rows.sort(key=lambda item: item["verdict"]["key"])

    buckets = sorted(grouped)
    allocation = {bucket: 0 for bucket in buckets}
    if take >= len(buckets):
        for bucket in buckets:
            allocation[bucket] = 1
    else:
        # A tiny diagnostic sample cannot cover every stratum. Prefer the most
        # populous strata, with the bucket number as deterministic tie-breaker.
        for bucket in sorted(buckets, key=lambda b: (-len(grouped[b]), b))[:take]:
            allocation[bucket] = 1

    remaining = take - sum(allocation.values())
    total = sum(len(grouped[bucket]) for bucket in buckets)
    if remaining > 0:
        ideals = {
            bucket: take * len(grouped[bucket]) / total
            for bucket in buckets
        }
        while remaining:
            candidates = [
                bucket for bucket in buckets
                if allocation[bucket] < len(grouped[bucket])
            ]
            if not candidates:
                raise PanelContractError("sample allocation exhausted unexpectedly")
            chosen = max(
                candidates,
                key=lambda bucket: (
                    ideals[bucket] - allocation[bucket],
                    len(grouped[bucket]) - allocation[bucket],
                    -bucket,
                ),
            )
            allocation[chosen] += 1
            remaining -= 1

    rng = random.Random(seed)
    sampled: list[dict] = []
    for bucket in buckets:
        candidates = list(grouped[bucket])
        rng.shuffle(candidates)
        sampled.extend(candidates[:allocation[bucket]])
    rng.shuffle(sampled)
    counts = {str(bucket): allocation[bucket] for bucket in buckets}
    return sampled, counts


def sample_fingerprint(sample_rows: list[dict]) -> str:
    return _fingerprint(sample_rows)


def panel_sample_rows(sample_rows: list[dict], language: str) -> list[dict]:
    """Flatten the review-relevant fields while retaining full queue evidence."""
    output = []
    for item in sample_rows:
        verdict = item["verdict"]
        queue = item["queue"]
        chosen = next(
            (
                alt for alt in (queue.get("alternatives") or [])
                if alt.get("target") == verdict.get("target")
            ),
            None,
        )
        output.append({
            "lang": language,
            "key": verdict["key"],
            "target": verdict.get("target"),
            "pos": verdict.get("pos"),
            "shipTier": verdict.get("shipTier"),
            "gender": verdict.get("gender"),
            "plural": verdict.get("plural"),
            "confidence": verdict.get("confidence"),
            "entrSenses": queue.get("entrSenses") or [],
            "chosenAlternative": chosen,
            "evidenceTier": queue.get("evidenceTier"),
            "enZipf": queue.get("enZipf"),
            "origin": item["origin"],
        })
    return output


def build_sample_contract(
    root: Path,
    language: str,
    *,
    sample_size: int,
    seed: int,
    batch_size: int = DEFAULT_BATCH_SIZE,
    file_index_base: int = DEFAULT_FILE_INDEX_BASE,
) -> tuple[PendingMintUniverse, list[dict], dict]:
    universe = compute_pending_strict_mint_universe(
        root,
        language,
        batch_size=batch_size,
        file_index_base=file_index_base,
    )
    sampled, buckets = deterministic_sample(universe, sample_size=sample_size, seed=seed)
    contract = {
        "schemaVersion": SCHEMA_VERSION,
        "lang": language,
        "seed": seed,
        "requestedSampleSize": sample_size,
        "batchSize": batch_size,
        "fileIndexBase": file_index_base,
        "eligible": universe.eligible,
        "sampled": len(sampled),
        "buckets": buckets,
        "universeFingerprint": universe.fingerprint,
        "sampleFingerprint": sample_fingerprint(sampled),
        "sampleKeys": [item["verdict"]["key"] for item in sampled],
        "pendingFiles": list(universe.pending_files),
    }
    return universe, sampled, contract


def _finite_number(value, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise PanelContractError(f"panel field {field} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise PanelContractError(f"panel field {field} must be finite")
    return number


def reduce_panel_results(
    root: Path,
    language: str,
    result_paths: list[Path],
    *,
    sample_size: int,
    seed: int,
    ship_bar: float = DEFAULT_SHIP_BAR,
    batch_size: int = DEFAULT_BATCH_SIZE,
    file_index_base: int = DEFAULT_FILE_INDEX_BASE,
) -> dict:
    universe, sampled, contract = build_sample_contract(
        root,
        language,
        sample_size=sample_size,
        seed=seed,
        batch_size=batch_size,
        file_index_base=file_index_base,
    )
    expected_keys = contract["sampleKeys"]
    expected_set = set(expected_keys)
    judgments: dict[str, dict] = {}
    per_agent = []
    for agent_index, path in enumerate(result_paths):
        rows = load_jsonl_strict(path)
        errors = 0
        for row in rows:
            key = row.get("key")
            if key not in expected_set:
                raise PanelContractError(f"panel result has foreign key {key!r}: {path}")
            if key in judgments:
                raise PanelContractError(f"panel result duplicates sampled key {key!r}")
            if not isinstance(row.get("ok"), bool):
                raise PanelContractError(f"panel result key {key!r} lacks boolean ok")
            reason = row.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                raise PanelContractError(f"panel result key {key!r} lacks a reason")
            judgments[key] = row
            errors += row["ok"] is False
        per_agent.append({"agent": agent_index, "checked": len(rows), "errors": errors})
    if set(judgments) != expected_set:
        missing = sorted(expected_set - set(judgments))[:10]
        raise PanelContractError(f"panel results do not exactly cover sample; missing={missing}")

    false_keys = [key for key in expected_keys if judgments[key]["ok"] is False]
    sampled_count = len(expected_keys)
    errors = len(false_keys)
    error_rate = errors / sampled_count
    bar = _finite_number(ship_bar, "shipBar")
    if not 0 <= bar <= 1:
        raise PanelContractError("ship_bar must be between 0 and 1")
    decision = "ship" if error_rate <= bar else "block"
    return {
        **contract,
        "runIndex": seed,
        "shipBar": bar,
        "errors": errors,
        "errorRate": error_rate,
        "decision": decision,
        "falseKeys": false_keys,
        "errorExamples": [
            {"key": key, "reason": judgments[key]["reason"]}
            for key in false_keys
        ],
        "perAgent": per_agent,
        "universeRows": universe.eligible,
    }


def validate_panel_verdict(
    root: Path,
    language: str,
    panel_path: Path,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    file_index_base: int = DEFAULT_FILE_INDEX_BASE,
) -> PanelAuthorization:
    panel = load_json_strict(Path(panel_path))
    if not isinstance(panel, dict):
        raise PanelContractError("panel verdict must be a JSON object")
    required = {
        "schemaVersion", "lang", "runIndex", "seed", "requestedSampleSize",
        "batchSize", "fileIndexBase", "eligible", "sampled", "errors",
        "errorRate", "decision", "shipBar", "universeFingerprint",
        "sampleFingerprint", "sampleKeys", "falseKeys", "errorExamples",
    }
    missing = sorted(required - set(panel))
    if missing:
        raise PanelContractError(f"panel verdict missing required fields: {missing}")
    if panel["schemaVersion"] != SCHEMA_VERSION:
        raise PanelContractError(
            f"unsupported panel schemaVersion {panel['schemaVersion']!r}"
        )
    if panel["lang"] != language:
        raise PanelContractError(
            f"panel language {panel['lang']!r} does not match {language!r}"
        )

    for field in (
        "seed", "runIndex", "requestedSampleSize", "batchSize",
        "fileIndexBase", "eligible", "sampled", "errors",
    ):
        value = panel[field]
        if not isinstance(value, int) or isinstance(value, bool):
            raise PanelContractError(f"panel field {field} must be an integer")
    if panel["runIndex"] != panel["seed"]:
        raise PanelContractError("panel runIndex must equal its deterministic seed")
    if panel["requestedSampleSize"] <= 0:
        raise PanelContractError("panel requestedSampleSize must be positive")
    if panel["batchSize"] != batch_size:
        raise PanelContractError(
            f"panel batchSize {panel['batchSize']} does not match apply batch size {batch_size}"
        )
    if panel["fileIndexBase"] != file_index_base:
        raise PanelContractError(
            "panel fileIndexBase does not match apply file-index base "
            f"{file_index_base}"
        )
    if panel["sampled"] <= 0:
        raise PanelContractError("panel sampled must be positive")
    if panel["errors"] < 0 or panel["errors"] > panel["sampled"]:
        raise PanelContractError("panel errors must be between zero and sampled")

    universe, sampled, contract = build_sample_contract(
        root,
        language,
        sample_size=panel["requestedSampleSize"],
        seed=panel["seed"],
        batch_size=batch_size,
        file_index_base=file_index_base,
    )
    if panel["eligible"] != universe.eligible:
        raise PanelContractError(
            f"stale panel eligible count {panel['eligible']} != {universe.eligible}"
        )
    if panel["universeFingerprint"] != universe.fingerprint:
        raise PanelContractError("stale panel universe fingerprint")
    expected_sampled = min(panel["requestedSampleSize"], universe.eligible)
    if panel["sampled"] != expected_sampled:
        raise PanelContractError(
            f"panel sampled {panel['sampled']} != requested/universe count {expected_sampled}"
        )
    if panel["sampleKeys"] != contract["sampleKeys"]:
        raise PanelContractError("panel sample keys do not match deterministic sample")
    if panel["sampleFingerprint"] != sample_fingerprint(sampled):
        raise PanelContractError("panel sample fingerprint mismatch")

    sample_keys = panel["sampleKeys"]
    if (
        not isinstance(sample_keys, list)
        or any(not isinstance(key, str) or not key for key in sample_keys)
        or len(sample_keys) != len(set(sample_keys))
        or len(sample_keys) != panel["sampled"]
    ):
        raise PanelContractError("panel sampleKeys must be unique strings matching sampled")
    false_keys = panel["falseKeys"]
    if (
        not isinstance(false_keys, list)
        or any(not isinstance(key, str) or not key for key in false_keys)
        or len(false_keys) != len(set(false_keys))
    ):
        raise PanelContractError("panel falseKeys must be a unique string list")
    if len(false_keys) != panel["errors"]:
        raise PanelContractError("panel errors must equal the complete falseKeys count")
    if not set(false_keys) <= set(sample_keys):
        raise PanelContractError("panel falseKeys must be sampled universe keys")

    examples = panel["errorExamples"]
    if not isinstance(examples, list):
        raise PanelContractError("panel errorExamples must be a list")
    example_keys: list[str] = []
    for example in examples:
        if not isinstance(example, dict):
            raise PanelContractError("panel errorExamples entries must be objects")
        key = example.get("key")
        reason = example.get("reason")
        if not isinstance(key, str) or not isinstance(reason, str) or not reason.strip():
            raise PanelContractError("panel errorExamples require key and non-empty reason")
        example_keys.append(key)
    if example_keys != false_keys:
        raise PanelContractError(
            "panel errorExamples must completely and in-order describe falseKeys"
        )

    error_rate = _finite_number(panel["errorRate"], "errorRate")
    ship_bar = _finite_number(panel["shipBar"], "shipBar")
    if not 0 <= ship_bar <= 1:
        raise PanelContractError("panel shipBar must be between zero and one")
    if not math.isclose(ship_bar, DEFAULT_SHIP_BAR, rel_tol=0, abs_tol=1e-12):
        raise PanelContractError(
            f"panel shipBar {ship_bar} does not match production bar {DEFAULT_SHIP_BAR}"
        )
    expected_rate = panel["errors"] / panel["sampled"]
    if not math.isclose(error_rate, expected_rate, rel_tol=0, abs_tol=1e-12):
        raise PanelContractError(
            f"panel errorRate {error_rate} != errors/sampled {expected_rate}"
        )
    expected_decision = "ship" if expected_rate <= ship_bar else "block"
    if not isinstance(panel["decision"], str) or panel["decision"] not in {"ship", "block"}:
        raise PanelContractError(f"invalid panel decision {panel['decision']!r}")
    if panel["decision"] != expected_decision:
        raise PanelContractError(
            f"panel decision {panel['decision']!r} contradicts its error arithmetic"
        )
    if panel["decision"] != "ship":
        raise PanelContractError("panel decision blocks apply")

    return PanelAuthorization(
        panel_path=Path(panel_path),
        false_keys=frozenset(false_keys),
        universe_fingerprint=universe.fingerprint,
        sample_fingerprint=panel["sampleFingerprint"],
        sampled=panel["sampled"],
        errors=panel["errors"],
    )


def _write_text_exact(path: Path, text: str) -> None:
    if path.exists():
        if path.read_text(encoding="utf-8") != text:
            raise PanelContractError(f"refusing to overwrite mismatched frozen output: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # A hard link makes the complete temporary inode visible at `path`
        # without overwriting an output another concurrent resume just froze.
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.read_text(encoding="utf-8") != text:
                raise PanelContractError(
                    f"refusing to overwrite mismatched frozen output: {path}"
                )
    finally:
        temporary.unlink(missing_ok=True)


def _write_jsonl_exact(path: Path, rows: list[dict]) -> None:
    text = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        for row in rows
    )
    _write_text_exact(path, text)


def _write_json_exact(path: Path, value: dict) -> None:
    _write_text_exact(
        path,
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    )


def _common_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--language", required=True, choices=sorted(LANGUAGES))
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--file-index-base", type=int, default=DEFAULT_FILE_INDEX_BASE)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    sample_parser = subparsers.add_parser("sample")
    _common_parser(sample_parser)
    sample_parser.add_argument("--seed", type=int, required=True)
    sample_parser.add_argument("--sample-size", type=int, required=True)
    sample_parser.add_argument("--output", type=Path)

    reduce_parser = subparsers.add_parser("reduce")
    _common_parser(reduce_parser)
    reduce_parser.add_argument("--seed", type=int, required=True)
    reduce_parser.add_argument("--sample-size", type=int, required=True)
    reduce_parser.add_argument("--ship-bar", type=float, default=DEFAULT_SHIP_BAR)
    reduce_parser.add_argument("--results", action="append", type=Path, required=True)
    reduce_parser.add_argument("--output", type=Path, required=True)

    validate_parser = subparsers.add_parser("validate")
    _common_parser(validate_parser)
    validate_parser.add_argument("--panel-verdict", type=Path, required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "sample":
            universe, sampled, contract = build_sample_contract(
                args.root,
                args.language,
                sample_size=args.sample_size,
                seed=args.seed,
                batch_size=args.batch_size,
                file_index_base=args.file_index_base,
            )
            if args.output:
                _write_jsonl_exact(
                    args.output,
                    panel_sample_rows(sampled, args.language),
                )
            result = {
                "ok": True,
                **contract,
                "output": str(args.output) if args.output else None,
                "appliedFiles": list(universe.applied_files),
            }
        elif args.command == "reduce":
            result = reduce_panel_results(
                args.root,
                args.language,
                args.results,
                sample_size=args.sample_size,
                seed=args.seed,
                ship_bar=args.ship_bar,
                batch_size=args.batch_size,
                file_index_base=args.file_index_base,
            )
            _write_json_exact(args.output, result)
            result = {"ok": True, "output": str(args.output), **result}
        else:
            authorization = validate_panel_verdict(
                args.root,
                args.language,
                args.panel_verdict,
                batch_size=args.batch_size,
                file_index_base=args.file_index_base,
            )
            result = {
                "ok": True,
                "panelVerdict": str(authorization.panel_path),
                "universeFingerprint": authorization.universe_fingerprint,
                "sampleFingerprint": authorization.sample_fingerprint,
                "sampled": authorization.sampled,
                "errors": authorization.errors,
                "falseKeys": sorted(authorization.false_keys),
            }
    except PanelContractError as exc:
        result = {"ok": False, "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
