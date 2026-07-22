#!/usr/bin/env python3
"""Append source-authorized rows omitted by legacy target-side queue gates.

The Wave 2 ordered queues predate the English source-POS contract. Their
existing prefix is an immutable batch map, but rows marked `shippable:false` or
with a target-derived `preSkip` were omitted before that contract existed.
This one-shot recovery preserves every existing byte and key in the ordered
prefix, then appends only canonical rows with at least one mechanically valid
source-authorized path:

* a standalone, non-identical target authorized as an English non-noun; or
* a standalone target authorized as an English noun with allowed gender and a
  standalone plural.

Legacy `shippable`, `preSkip`, alternative `pos`, and alternative `mintable`
are never consulted. Dry-run is the default. Production `--write` is all-four
languages only and refuses any runner manifest or artifact filename that would
overlap an affected batch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from pipeline.analysis import build_mint_queue as bmq
from pipeline.analysis.mint_panel_contract import evidence_bucket


REPO_ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ("de", "fr", "it", "es")
BATCH_SIZE = 100
FILE_INDEX_BASE = 10_000
MANIFEST_NAME = "mint-source-pos-recovery-manifest.json"
LOCK_NAME = "mint-source-pos-recovery.lock"
BACKUP_SUFFIX = ".pre-source-pos-recovery"

# Exact guards for the already-persisted Wave 1/Wave 2 mapping. These are
# checked only against the real repository, never temporary test fixtures.
PRODUCTION_LEGACY_ROWS = {"de": 17_000, "fr": 13_677, "it": 13_555, "es": 11_184}
PRODUCTION_EXTENSION_ROWS = {"de": 780, "fr": 165, "it": 388, "es": 1_036}
PRODUCTION_LEGACY_KEY_DIGESTS = {
    "de": "1e4aec816d41af15310d37c9ed481b8668b0dbd8c53f0ea15b3d7075e1378bc5",
    "fr": "84da36c65cc291a904de6129f55ef61cd4779583d2106f64dc4caf5064b1eb73",
    "it": "9230e29daf19295b0a2c61937b188975485dd046d91df10a1ca230a1b67e60c4",
    "es": "5edde628d45678af9c11fdbea8f8115bc2abdf2a765bf7cc0900def5a354b97d",
}


class RecoveryError(RuntimeError):
    """A fail-closed recovery precondition did not hold."""


@dataclass(frozen=True)
class LanguageRecovery:
    language: str
    ordered_path: Path
    original_bytes: bytes
    replacement_bytes: bytes
    extension_rows: tuple[dict, ...]
    report: dict


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _key_digest(rows: list[dict] | tuple[dict, ...]) -> str:
    keys = [row.get("key") for row in rows]
    if any(not isinstance(key, str) or not key for key in keys):
        raise RecoveryError("queue row lacks a non-empty string key")
    if len(keys) != len(set(keys)):
        raise RecoveryError("queue contains duplicate keys")
    return hashlib.sha256("\n".join(keys).encode("utf-8")).hexdigest()


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RecoveryError(f"cannot read JSON {path}: {exc}") from exc


def _load_jsonl(path: Path, *, allow_missing: bool = False) -> list[dict]:
    if not path.exists():
        if allow_missing:
            return []
        raise RecoveryError(f"missing JSONL file: {path}")
    rows: list[dict] = []
    try:
        raw_lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise RecoveryError(f"cannot read {path}: {exc}") from exc
    for line_number, line in enumerate(raw_lines, 1):
        if not line.strip():
            raise RecoveryError(f"blank line in {path}:{line_number}")
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RecoveryError(f"invalid JSONL {path}:{line_number}: {exc}") from exc
        if not isinstance(row, dict):
            raise RecoveryError(f"non-object JSONL row {path}:{line_number}")
        rows.append(row)
    return rows


def _unique(rows: list[dict], label: str) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for row in rows:
        key = row.get("key")
        if not isinstance(key, str) or not key:
            raise RecoveryError(f"{label} has a row without a key")
        if key in result:
            raise RecoveryError(f"{label} has duplicate key {key!r}")
        result[key] = row
    return result


def _all_pack_keys(root: Path, language: str) -> set[str]:
    keys: set[str] = set()
    for suffix in ("", ".tail"):
        pack = _load_json(root / f"public/language-packs/{language}{suffix}.json")
        entries = pack.get("entries")
        if not isinstance(entries, dict):
            raise RecoveryError(f"{language}{suffix} pack lacks entries")
        keys.update(entries)
    return keys


def _artifact_keys(root: Path, language: str) -> set[str]:
    verdicts = root / "pipeline/data/verdicts"
    keys: set[str] = set()
    for stage in ("raw", "final", "fixup"):
        for path in (verdicts / stage).glob(f"mint-{language}-*.jsonl"):
            keys.update(_unique(_load_jsonl(path), str(path)).keys())
    return keys


def _trial_keys(root: Path, language: str) -> set[str]:
    rows = _load_jsonl(
        root / "pipeline/data/queues/minttrial-mixed.jsonl", allow_missing=True
    )
    return {
        row["key"] for row in rows
        if row.get("lang") == language and isinstance(row.get("key"), str)
    }


def _valid_sources(alternative: dict) -> bool:
    sources = alternative.get("sources")
    return (
        isinstance(sources, list)
        and bool(sources)
        and all(isinstance(source, str) and source.strip() for source in sources)
    )


def _recoverable_row(row: dict, language: str) -> bool:
    key = row.get("key")
    source = row.get("source")
    if not isinstance(key, str) or not isinstance(source, str):
        raise RecoveryError(f"{language}: queue row lacks key/source")
    if key != source.strip().lower():
        raise RecoveryError(f"{language}:{key}: key != source.strip().lower()")
    row_candidates = row.get("sourcePosCandidates")
    alternatives = row.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        raise RecoveryError(f"{language}:{key}: missing alternatives")

    recoverable = False
    for alternative in alternatives:
        if not isinstance(alternative, dict) or not _valid_sources(alternative):
            raise RecoveryError(f"{language}:{key}: malformed alternative provenance")
        try:
            path = bmq.source_contract_path(
                key, alternative, row_candidates, language
            )
        except (TypeError, ValueError) as exc:
            raise RecoveryError(f"{language}:{key}: {exc}") from exc
        recoverable = recoverable or path["mintable"]
    return recoverable


def _extension_sort_key(row: dict) -> tuple:
    en_zipf = row.get("enZipf")
    if (
        not isinstance(en_zipf, (int, float))
        or isinstance(en_zipf, bool)
        or not math.isfinite(float(en_zipf))
    ):
        raise RecoveryError(f"{row.get('key')}: enZipf must be finite numeric")
    return (evidence_bucket({"queue": row}), -float(en_zipf), row["key"])


def _assert_affected_batches_are_unused(
    root: Path, language: str, legacy_count: int, new_count: int
) -> tuple[int, int]:
    first = FILE_INDEX_BASE + legacy_count // BATCH_SIZE
    last = FILE_INDEX_BASE + (new_count - 1) // BATCH_SIZE
    verdicts = root / "pipeline/data/verdicts"
    collisions: list[str] = []
    for file_index in range(first, last + 1):
        basename = f"mint-{language}-{file_index}.jsonl"
        for stage in ("raw", "final", "fixup"):
            path = verdicts / stage / basename
            if path.exists():
                collisions.append(str(path))
        marker = verdicts / "applied" / f"{basename}.done"
        if marker.exists():
            collisions.append(str(marker))
    if collisions:
        raise RecoveryError(
            f"{language}: affected ordered batches already have artifacts: {collisions}"
        )
    return first, last


def build_language_recovery(root: Path, language: str) -> LanguageRecovery:
    queue_dir = root / "pipeline/data/queues"
    canonical_path = queue_dir / f"mint-{language}.jsonl"
    ordered_path = queue_dir / f"mint-{language}.ordered.jsonl"
    canonical_rows = _load_jsonl(canonical_path)
    ordered_rows = _load_jsonl(ordered_path)
    canonical = _unique(canonical_rows, str(canonical_path))
    ordered = _unique(ordered_rows, str(ordered_path))
    for key, row in ordered.items():
        if key not in canonical or row != canonical[key]:
            raise RecoveryError(
                f"{language}:{key}: ordered prefix is not a verbatim canonical row"
            )

    excluded = _all_pack_keys(root, language) | _trial_keys(root, language)
    excluded |= _artifact_keys(root, language)
    candidates: list[dict] = []
    for row in canonical_rows:
        key = row["key"]
        if key in ordered:
            continue
        if _recoverable_row(row, language):
            if key in excluded:
                raise RecoveryError(
                    f"{language}:{key}: recoverable key overlaps pack/trial/verdict state"
                )
            candidates.append(row)
    candidates.sort(key=_extension_sort_key)

    original_bytes = ordered_path.read_bytes()
    if original_bytes and not original_bytes.endswith(b"\n"):
        raise RecoveryError(f"{ordered_path}: ordered prefix lacks terminal newline")
    extension_bytes = b"".join(
        (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        for row in candidates
    )
    replacement_bytes = original_bytes + extension_bytes
    new_count = len(ordered_rows) + len(candidates)
    first_index, last_index = _assert_affected_batches_are_unused(
        root, language, len(ordered_rows), new_count
    )
    report = {
        "legacyRows": len(ordered_rows),
        "appendedRows": len(candidates),
        "newRows": new_count,
        "legacyByteSha256": _sha(original_bytes),
        "legacyKeySha256": _key_digest(ordered_rows),
        "extensionKeySha256": _key_digest(candidates),
        "newByteSha256": _sha(replacement_bytes),
        "firstAffectedFileIndex": first_index,
        "lastAffectedFileIndex": last_index,
        "firstExtensionKey": candidates[0]["key"] if candidates else None,
        "lastExtensionKey": candidates[-1]["key"] if candidates else None,
    }
    return LanguageRecovery(
        language=language,
        ordered_path=ordered_path,
        original_bytes=original_bytes,
        replacement_bytes=replacement_bytes,
        extension_rows=tuple(candidates),
        report=report,
    )


def build_recovery_plan(root: Path, languages: tuple[str, ...]) -> tuple[dict, dict[str, LanguageRecovery]]:
    root = root.resolve()
    runner_manifest = root / "pipeline/data/scratch/wave2-codex-runner/state/manifest.json"
    if runner_manifest.exists():
        raise RecoveryError(f"runner manifest already exists: {runner_manifest}")
    recoveries = {
        language: build_language_recovery(root, language) for language in languages
    }
    if root == REPO_ROOT.resolve():
        for language, recovery in recoveries.items():
            if recovery.report["legacyRows"] != PRODUCTION_LEGACY_ROWS[language]:
                raise RecoveryError(f"{language}: production legacy row-count drift")
            if recovery.report["appendedRows"] != PRODUCTION_EXTENSION_ROWS[language]:
                raise RecoveryError(f"{language}: production extension cohort drift")
            if recovery.report["legacyKeySha256"] != PRODUCTION_LEGACY_KEY_DIGESTS[language]:
                raise RecoveryError(f"{language}: production legacy key-digest drift")
    plan = {
        "schemaVersion": 1,
        "batchSize": BATCH_SIZE,
        "fileIndexBase": FILE_INDEX_BASE,
        "languages": {
            language: recoveries[language].report for language in languages
        },
    }
    canonical = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    plan["planSha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return plan, recoveries


def verify_existing_recovery(root: Path, languages: tuple[str, ...]) -> dict:
    """Verify the durable recovery ledger, prefix backup, and current queues."""
    root = root.resolve()
    manifest_path = root / "pipeline/data/queues" / MANIFEST_NAME
    manifest = _load_json(manifest_path)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise RecoveryError(f"invalid recovery manifest: {manifest_path}")
    supplied_sha = manifest.get("planSha256")
    unsigned = dict(manifest)
    unsigned.pop("planSha256", None)
    canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if supplied_sha != hashlib.sha256(canonical.encode("utf-8")).hexdigest():
        raise RecoveryError("recovery manifest planSha256 mismatch")

    reports = manifest.get("languages")
    if not isinstance(reports, dict):
        raise RecoveryError("recovery manifest lacks language reports")
    for language in languages:
        report = reports.get(language)
        if not isinstance(report, dict):
            raise RecoveryError(f"recovery manifest lacks {language}")
        ordered_path = root / f"pipeline/data/queues/mint-{language}.ordered.jsonl"
        backup_path = ordered_path.with_name(ordered_path.name + BACKUP_SUFFIX)
        if not ordered_path.exists() or not backup_path.exists():
            raise RecoveryError(f"{language}: recovered queue or prefix backup is missing")
        try:
            current_bytes = ordered_path.read_bytes()
            legacy_bytes = backup_path.read_bytes()
        except OSError as exc:
            raise RecoveryError(f"{language}: cannot read recovered queue state: {exc}") from exc
        if _sha(current_bytes) != report.get("newByteSha256"):
            raise RecoveryError(f"{language}: recovered ordered byte hash drift")
        if _sha(legacy_bytes) != report.get("legacyByteSha256"):
            raise RecoveryError(f"{language}: recovery prefix backup hash drift")
        if not current_bytes.startswith(legacy_bytes):
            raise RecoveryError(f"{language}: recovered queue no longer preserves prefix bytes")

        current_rows = _load_jsonl(ordered_path)
        legacy_rows = _load_jsonl(backup_path)
        if len(legacy_rows) != report.get("legacyRows"):
            raise RecoveryError(f"{language}: recovery prefix row-count drift")
        if len(current_rows) != report.get("newRows"):
            raise RecoveryError(f"{language}: recovered ordered row-count drift")
        extension_rows = current_rows[len(legacy_rows):]
        if len(extension_rows) != report.get("appendedRows"):
            raise RecoveryError(f"{language}: recovered extension row-count drift")
        if _key_digest(legacy_rows) != report.get("legacyKeySha256"):
            raise RecoveryError(f"{language}: recovery prefix key-digest drift")
        if _key_digest(extension_rows) != report.get("extensionKeySha256"):
            raise RecoveryError(f"{language}: recovery extension key-digest drift")

        canonical_rows = _load_jsonl(
            root / f"pipeline/data/queues/mint-{language}.jsonl"
        )
        canonical_by_key = _unique(canonical_rows, f"{language} canonical queue")
        for row in current_rows:
            if canonical_by_key.get(row.get("key")) != row:
                raise RecoveryError(
                    f"{language}:{row.get('key')}: recovered row drifted from canonical"
                )
    return manifest


def _write_temp(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(6).hex()}.tmp")
    with temp.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    return temp


def _restore_atomic(path: Path, payload: bytes) -> None:
    temp = _write_temp(path, payload)
    os.replace(temp, path)


def write_recovery(root: Path, plan: dict, recoveries: dict[str, LanguageRecovery]) -> None:
    queue_dir = root / "pipeline/data/queues"
    manifest_path = queue_dir / MANIFEST_NAME
    lock_path = queue_dir / LOCK_NAME
    if manifest_path.exists():
        raise RecoveryError(f"recovery manifest already exists: {manifest_path}")
    lock_fd = None
    staged: dict[Path, Path] = {}
    replaced: list[LanguageRecovery] = []
    try:
        lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(lock_fd, (json.dumps({"pid": os.getpid()}) + "\n").encode("utf-8"))
        os.fsync(lock_fd)
        for recovery in recoveries.values():
            backup = recovery.ordered_path.with_name(
                recovery.ordered_path.name + BACKUP_SUFFIX
            )
            if backup.exists():
                if _sha(backup.read_bytes()) != recovery.report["legacyByteSha256"]:
                    raise RecoveryError(f"stale recovery backup differs: {backup}")
            else:
                try:
                    os.link(recovery.ordered_path, backup)
                except OSError:
                    shutil.copy2(recovery.ordered_path, backup)
            staged[recovery.ordered_path] = _write_temp(
                recovery.ordered_path, recovery.replacement_bytes
            )
        manifest_payload = (json.dumps(plan, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        staged[manifest_path] = _write_temp(manifest_path, manifest_payload)

        for recovery in recoveries.values():
            os.replace(staged.pop(recovery.ordered_path), recovery.ordered_path)
            replaced.append(recovery)
        # The lock serializes this writer; the hard link additionally prevents
        # an unexpected manifest from being overwritten.
        os.link(staged[manifest_path], manifest_path)
        staged[manifest_path].unlink()
        staged.pop(manifest_path)
    except Exception:
        rollback_errors: list[str] = []
        for recovery in reversed(replaced):
            try:
                _restore_atomic(recovery.ordered_path, recovery.original_bytes)
            except Exception as rollback_exc:  # pragma: no cover - catastrophic I/O failure
                rollback_errors.append(f"{recovery.language}: {rollback_exc}")
        if rollback_errors:
            raise RecoveryError(f"recovery failed and rollback was incomplete: {rollback_errors}")
        raise
    finally:
        for temp in staged.values():
            try:
                temp.unlink()
            except FileNotFoundError:
                pass
        if lock_fd is not None:
            os.close(lock_fd)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--language", action="append", choices=LANGUAGES)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    languages = tuple(dict.fromkeys(args.language or LANGUAGES))
    if args.write and languages != LANGUAGES:
        parser.error("production --write is all-four languages only")
    try:
        root = args.data_root.resolve()
        manifest_path = root / "pipeline/data/queues" / MANIFEST_NAME
        if manifest_path.exists():
            plan = verify_existing_recovery(root, languages)
            print(json.dumps({
                "ok": True,
                "write": False,
                "alreadyRecovered": True,
                **plan,
            }, indent=2))
            return 0
        plan, recoveries = build_recovery_plan(root, languages)
        if args.write:
            write_recovery(root, plan, recoveries)
    except RecoveryError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        return 1
    print(json.dumps({"ok": True, "write": args.write, **plan}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
