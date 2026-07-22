"""Fail-closed fixtures for deterministic mint-panel authorization."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pipeline.analysis.apply_verdicts as apply_verdicts_module
from pipeline.analysis.apply_verdicts import apply_language, main as apply_main
from pipeline.analysis.mint_panel_contract import (
    PanelContractError,
    reduce_panel_results,
    ship_stratum_ok,
)


LANG = "de"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


class MintPanelApplyContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mint-panel-contract-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.pack_path = self.tmp / "public" / "language-packs" / f"{LANG}.json"
        write_json(self.pack_path, {
            "version": "test",
            "sourceLanguage": "en",
            "targetLanguage": LANG,
            "displayName": "German",
            "sources": {},
            "entries": {},
        })

        # Twenty-one rows let one panel-proven false key remain below the real
        # production bar (1/21 ~= 4.76%) while still exercising suppression.
        pairs = [
            ("panelgood", "gut"),
            ("panelbad", "schlecht"),
            *[(f"panelextra{index:02d}", f"zusatz{index:02d}") for index in range(19)],
        ]
        self.queue_rows = [self._queue_row(key, target) for key, target in pairs]
        queues = self.tmp / "pipeline" / "data" / "queues"
        write_jsonl(queues / f"mint-{LANG}.jsonl", self.queue_rows)
        # The production contract requires a frozen verbatim ordered queue.
        write_jsonl(queues / f"mint-{LANG}.ordered.jsonl", self.queue_rows)

        self.final_rows = [self._verdict_row(key, target) for key, target in pairs]
        self.final_path = (
            self.tmp / "pipeline" / "data" / "verdicts" / "final"
            / f"mint-{LANG}-10000.jsonl"
        )
        write_jsonl(self.final_path, self.final_rows)

    @staticmethod
    def _queue_row(key: str, target: str) -> dict:
        return {
            "lang": LANG,
            "key": key,
            "source": key,
            "enZipf": 3.0,
            "shipTierHint": "tail",
            "sourcePosCandidates": ["adjective"],
            "sourcePos": "adjective",
            "alternatives": [{
                "target": target,
                "votes": 2,
                "sources": ["freedict", "omw"],
                "glosses": [key],
                "morph": None,
                "sourcePosCandidates": ["adjective"],
            }],
        }

    @staticmethod
    def _verdict_row(key: str, target: str) -> dict:
        return {
            "key": key,
            "verdict": "mint",
            "target": target,
            "shipTier": "tail",
            "pos": "adjective",
            "confidence": 0.9,
            "reason": "fixture",
            "refuter": "agree",
        }

    def _panel(self, *, false_keys=(), ship_bar=0.05) -> Path:
        result_path = self.tmp / "panel-results.jsonl"
        write_jsonl(result_path, [
            {
                "key": row["key"],
                "ok": row["key"] not in false_keys,
                "reason": "panel rejected" if row["key"] in false_keys else "panel accepted",
            }
            for row in self.final_rows
        ])
        verdict = reduce_panel_results(
            self.tmp,
            LANG,
            [result_path],
            sample_size=len(self.final_rows),
            seed=20260720,
            ship_bar=ship_bar,
        )
        panel_path = self.tmp / "panel-verdict.json"
        write_json(panel_path, verdict)
        return panel_path

    def _assert_no_apply_writes(self, original_pack: str) -> None:
        self.assertEqual(self.pack_path.read_text(encoding="utf-8"), original_pack)
        self.assertFalse(
            (self.tmp / "pipeline" / "data" / "verdicts" / "applied").exists()
        )
        self.assertFalse(
            (self.tmp / "public" / "language-packs" / f"{LANG}.tail.json").exists()
        )

    def test_judge_authority_must_be_a_nonempty_stage_identity(self):
        self.assertFalse(ship_stratum_ok({"confidence": 0.9, "judge": True}))
        self.assertFalse(ship_stratum_ok({"confidence": 0.9, "judge": "  "}))
        self.assertTrue(ship_stratum_ok({"confidence": 0.9, "judge": "judge-model"}))

    def test_cli_requires_explicit_panel_for_production_strict_mint_only(self):
        original_pack = self.pack_path.read_text(encoding="utf-8")
        exit_code = apply_main([
            "--language", LANG,
            "--data-root", str(self.tmp),
            "--mint-only",
            "--ship-stratum", "strict",
        ])
        self.assertEqual(exit_code, 1)
        self._assert_no_apply_writes(original_pack)

    def test_stale_universe_fingerprint_fails_before_writes(self):
        panel_path = self._panel()
        # Preserve exact key coverage but alter a fingerprinted effective row.
        changed = [dict(row) for row in self.final_rows]
        changed[0]["reason"] = "verdict changed after panel"
        write_jsonl(self.final_path, changed)
        original_pack = self.pack_path.read_text(encoding="utf-8")

        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("stale panel universe fingerprint", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_pending_nonnumeric_mint_final_cannot_bypass_panel_mapping(self):
        # apply_verdicts globs this broad name, so the panel must reject it
        # rather than silently fingerprinting only numeric mapped batches.
        stray = self.final_path.with_name(f"mint-{LANG}-backup.jsonl")
        write_jsonl(stray, [self.final_rows[0]])

        with self.assertRaisesRegex(
            PanelContractError, "unmapped pending mint verdict file"
        ):
            self._panel()

    def test_final_row_cannot_smuggle_judge_authority_into_panel_universe(self):
        smuggled = [dict(row) for row in self.final_rows]
        smuggled[0]["refuter"] = "unreviewed"
        smuggled[0]["judge"] = "self-authorized-final"
        write_jsonl(self.final_path, smuggled)

        with self.assertRaisesRegex(PanelContractError, "illegally carries judge"):
            self._panel()

    def test_disputed_final_requires_one_clean_judge_fixup(self):
        disputed = [dict(row) for row in self.final_rows]
        disputed[0]["refuter"] = "dispute"
        disputed[0]["refuterReason"] = "independent ruling required"
        write_jsonl(self.final_path, disputed)

        with self.assertRaisesRegex(PanelContractError, "exactly rule every disputed key"):
            self._panel()

        fixup = dict(disputed[0])
        fixup.pop("refuter")
        fixup.pop("refuterReason")
        fixup["judge"] = "judge-model"
        # A fixup may not smuggle the opposite stage's authority either.
        fixup["refuter"] = "agree"
        write_jsonl(
            self.tmp / "pipeline" / "data" / "verdicts" / "fixup"
            / self.final_path.name,
            [fixup],
        )
        with self.assertRaisesRegex(PanelContractError, "illegally carries refuter"):
            self._panel()

    def test_block_decision_fails_before_writes(self):
        panel_path = self._panel(false_keys={"panelbad", "panelextra00"})
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("panel decision blocks apply", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_missing_complete_false_key_list_fails_before_writes(self):
        panel_path = self._panel(false_keys={"panelbad"})
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel.pop("falseKeys")
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("missing required fields", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_missing_errors_field_fails_before_writes(self):
        panel_path = self._panel(false_keys={"panelbad"})
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel.pop("errors")
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("missing required fields", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_malformed_error_arithmetic_fails_before_writes(self):
        panel_path = self._panel(false_keys={"panelbad"})
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel["errorRate"] = 0.0
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("errors/sampled", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_wrong_language_panel_fails_before_writes(self):
        panel_path = self._panel()
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel["lang"] = "fr"
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("does not match", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_shrunken_sample_count_fails_before_writes(self):
        panel_path = self._panel()
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel["sampled"] = 1
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("requested/universe count", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_relaxed_ship_bar_fails_before_writes(self):
        panel_path = self._panel(false_keys={"panelbad"})
        panel = json.loads(panel_path.read_text(encoding="utf-8"))
        panel["shipBar"] = 0.5
        write_json(panel_path, panel)
        original_pack = self.pack_path.read_text(encoding="utf-8")
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertFalse(report["ok"])
        self.assertIn("does not match production bar", report["notes"])
        self._assert_no_apply_writes(original_pack)

    def test_ship_suppresses_every_false_key_and_applies_only_passed_rows(self):
        panel_path = self._panel(false_keys={"panelbad"})
        report = apply_language(
            LANG,
            self.tmp,
            ship_stratum="strict",
            mint_only=True,
            panel_verdict_path=panel_path,
        )
        self.assertTrue(report["ok"], report)
        tail_path = self.tmp / "public" / "language-packs" / f"{LANG}.tail.json"
        tail = json.loads(tail_path.read_text(encoding="utf-8"))["entries"]
        self.assertIn("panelgood", tail)
        self.assertNotIn("panelbad", tail)
        self.assertEqual(report["counts"].get("mint_panel_false_noop"), 1)
        self.assertEqual(report["counts"].get("mint_tail"), 20)
        self.assertEqual(report["panel"]["suppressedKeys"], ["panelbad"])
        marker = (
            self.tmp / "pipeline" / "data" / "verdicts" / "applied"
            / f"mint-{LANG}-10000.jsonl.done"
        )
        self.assertTrue(marker.exists())

    def test_missing_suppression_hit_blocks_before_pack_or_marker_write(self):
        panel_path = self._panel(false_keys={"panelbad"})
        original_pack = self.pack_path.read_text(encoding="utf-8")
        real_effective_rows = apply_verdicts_module.effective_rows

        def traversal_drift(final_path, paths):
            return [
                row for row in real_effective_rows(final_path, paths)
                if row.get("key") != "panelbad"
            ]

        with patch(
            "pipeline.analysis.apply_verdicts.effective_rows",
            side_effect=traversal_drift,
        ):
            report = apply_language(
                LANG,
                self.tmp,
                ship_stratum="strict",
                mint_only=True,
                panel_verdict_path=panel_path,
            )

        self.assertFalse(report["ok"])
        self.assertIn("suppression contract failed before writes", report["notes"])
        self.assertIn("'panelbad': 0", report["notes"])
        self._assert_no_apply_writes(original_pack)


if __name__ == "__main__":
    unittest.main()
