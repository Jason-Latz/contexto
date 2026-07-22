"""Safety fixtures for append-only source-POS ordered-queue recovery."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pipeline.analysis.recover_mint_ordered_source_pos import (
    BACKUP_SUFFIX,
    MANIFEST_NAME,
    RecoveryError,
    build_recovery_plan,
    verify_existing_recovery,
    write_recovery,
)


LANG = "de"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def row(key: str, target: str, candidates: list[str], *, morph=None,
        en_zipf: float = 3.0, sources=None, target_pos="noun") -> dict:
    return {
        "lang": LANG,
        "key": key,
        "source": key,
        "enZipf": en_zipf,
        "sourcePosCandidates": list(candidates),
        "sourcePos": candidates[0] if len(candidates) == 1 else None,
        "entrSenses": [{"gloss": key, "containsAny": True}],
        "alternatives": [{
            "target": target,
            "votes": 2,
            "sources": ["freedict"] if sources is None else sources,
            "glosses": [key],
            "morph": morph,
            "pos": target_pos,
            "sourcePosCandidates": list(candidates),
            "mintable": False,
        }],
        "shipTierHint": "tail",
        "preSkip": "noun_no_morph_any",
        "shippable": False,
    }


class RecoverOrderedSourcePosTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="recover-source-pos-test-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        for suffix in ("", ".tail"):
            write_json(
                self.root / f"public/language-packs/{LANG}{suffix}.json",
                {"entries": {}},
            )
        write_jsonl(
            self.root / "pipeline/data/queues/minttrial-mixed.jsonl", []
        )

        self.existing = row("existing", "bestehend", ["adjective"], en_zipf=5.0)
        self.source_adverb = row(
            "affirmatively", "bejahung", ["adverb"], en_zipf=4.0,
            target_pos="noun",
        )
        self.noun = row(
            "widget", "Gerät", ["noun"], en_zipf=3.5,
            morph={"gender": "neuter", "plural": "Geräte", "authority": "wiktextract"},
        )
        self.identity = row("total", "total", ["adjective"], en_zipf=3.0)
        self.nonstandalone = row("jovian", "-jovisch", ["adjective"], en_zipf=2.9)
        self.noun_no_morph = row("orphan", "Waise", ["noun"], en_zipf=2.8)
        self.canonical = [
            self.existing,
            self.source_adverb,
            self.noun,
            self.identity,
            self.nonstandalone,
            self.noun_no_morph,
        ]
        queues = self.root / "pipeline/data/queues"
        write_jsonl(queues / f"mint-{LANG}.jsonl", self.canonical)
        write_jsonl(queues / f"mint-{LANG}.ordered.jsonl", [self.existing])

    def test_recovers_only_mechanically_viable_source_authorized_rows(self):
        plan, recoveries = build_recovery_plan(self.root, (LANG,))
        recovery = recoveries[LANG]
        self.assertEqual(
            [item["key"] for item in recovery.extension_rows],
            ["affirmatively", "widget"],
        )
        self.assertEqual(plan["languages"][LANG]["legacyRows"], 1)
        self.assertEqual(plan["languages"][LANG]["appendedRows"], 2)
        self.assertTrue(recovery.replacement_bytes.startswith(recovery.original_bytes))
        self.assertEqual(recovery.original_bytes, (
            self.root / f"pipeline/data/queues/mint-{LANG}.ordered.jsonl"
        ).read_bytes())

    def test_write_preserves_prefix_and_creates_exact_backup_and_manifest(self):
        plan, recoveries = build_recovery_plan(self.root, (LANG,))
        recovery = recoveries[LANG]
        write_recovery(self.root, plan, recoveries)

        ordered = recovery.ordered_path.read_bytes()
        self.assertEqual(ordered, recovery.replacement_bytes)
        self.assertTrue(ordered.startswith(recovery.original_bytes))
        backup = recovery.ordered_path.with_name(
            recovery.ordered_path.name + BACKUP_SUFFIX
        )
        self.assertEqual(backup.read_bytes(), recovery.original_bytes)
        manifest = json.loads(
            (self.root / "pipeline/data/queues" / MANIFEST_NAME).read_text()
        )
        self.assertEqual(manifest, plan)
        self.assertEqual(verify_existing_recovery(self.root, (LANG,)), plan)

    def test_any_affected_batch_artifact_blocks_recovery(self):
        write_jsonl(
            self.root / "pipeline/data/verdicts/final/mint-de-10000.jsonl",
            [{"key": "foreign"}],
        )
        with self.assertRaisesRegex(RecoveryError, "affected ordered batches"):
            build_recovery_plan(self.root, (LANG,))

    def test_recoverable_overlap_with_pack_state_fails_closed(self):
        write_json(
            self.root / f"public/language-packs/{LANG}.tail.json",
            {"entries": {"affirmatively": {"target": "bejahung"}}},
        )
        with self.assertRaisesRegex(RecoveryError, "overlaps pack/trial/verdict"):
            build_recovery_plan(self.root, (LANG,))

    def test_malformed_alternative_sources_fail_closed(self):
        broken = json.loads(json.dumps(self.canonical))
        broken[1]["alternatives"][0]["sources"] = []
        write_jsonl(
            self.root / f"pipeline/data/queues/mint-{LANG}.jsonl", broken
        )
        with self.assertRaisesRegex(RecoveryError, "malformed alternative provenance"):
            build_recovery_plan(self.root, (LANG,))


if __name__ == "__main__":
    unittest.main()
