from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pipeline.analysis.enrich_mint_source_pos import (
    BACKUP_SUFFIX,
    enrich_rows,
    ordered_key_digest,
    write_jsonl_with_backup,
)


class EnrichMintSourcePosTest(unittest.TestCase):
    def setUp(self):
        self.rows = [{
            "lang": "de",
            "key": "affirmatively",
            "source": "affirmatively",
            "enZipf": 2.5,
            "alternatives": [
                {"target": "affirmativ", "pos": "adjective", "votes": 2, "morph": None},
                {"target": "bejahend", "pos": "adjective", "votes": 1, "morph": None},
            ],
            "shipTierHint": "tail",
        }]
        self.indexes = {
            "freedict": {},
            "apertium": {"affirmatively": [{
                "target": "affirmativ", "sourcePos": "adv", "targetPos": "adj",
            }]},
            "omw": {},
            "entr": {},
            "wordnet_pos": {"affirmatively": {"r"}},
        }

    def test_enrichment_preserves_mapping_and_separates_target_pos(self):
        before = json.loads(json.dumps(self.rows))
        digest = ordered_key_digest(self.rows)
        enriched, stats = enrich_rows("de", self.rows, self.indexes)

        self.assertEqual(ordered_key_digest(enriched), digest)
        self.assertEqual(self.rows, before, "input rows must not be mutated")
        self.assertEqual(enriched[0]["sourcePosCandidates"], ["adverb"])
        self.assertEqual(enriched[0]["sourcePos"], "adverb")
        self.assertEqual(
            enriched[0]["alternatives"][0]["sourcePosCandidates"], ["adverb"]
        )
        self.assertEqual(enriched[0]["alternatives"][0]["pos"], "adjective")
        self.assertEqual(enriched[0]["alternatives"][1]["sourcePosCandidates"], [])
        self.assertEqual(stats["row_singleton"], 1)
        self.assertEqual(stats["top_alternative_pair_authorized"], 1)

    def test_duplicate_keys_fail_before_write(self):
        with self.assertRaisesRegex(ValueError, "duplicate keys"):
            enrich_rows("de", self.rows + self.rows, self.indexes)


class SourcePosQueueWriteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="source-pos-queue-write-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_write_is_atomic_and_first_original_is_preserved(self):
        path = self.tmp / "mint-de.jsonl"
        original = {"key": "old", "source": "old", "alternatives": []}
        replacement = {"key": "new", "source": "new", "alternatives": []}
        path.write_text(json.dumps(original) + "\n", encoding="utf-8")

        write_jsonl_with_backup(path, [replacement])
        backup = path.with_name(path.name + BACKUP_SUFFIX)
        self.assertEqual(json.loads(backup.read_text()), original)
        self.assertEqual(json.loads(path.read_text()), replacement)

        write_jsonl_with_backup(path, [{**replacement, "sourcePosCandidates": []}])
        self.assertEqual(json.loads(backup.read_text()), original)
        self.assertEqual(json.loads(path.read_text())["sourcePosCandidates"], [])


if __name__ == "__main__":
    unittest.main()
