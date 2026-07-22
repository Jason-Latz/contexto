"""Tiny fixture self-test for apply_verdicts.py.

Builds a throwaway repo layout (packs + queues + verdicts) under a tempdir and
runs apply_language against it -- the REAL packs under public/language-packs/
are never touched. Run directly:

    python3 pipeline/analysis/test_apply_verdicts.py
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pipeline.analysis.apply_verdicts import apply_language

LANG = "de"


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")


class ApplyVerdictsFixtureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="apply-verdicts-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        # ---- pre-existing packs (core has 4 entries to audit; tail has 1) ----
        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {},
            "entries": {
                "house": {
                    "source": "house", "target": "Wohnung", "sourceGloss": "house",
                    "partOfSpeech": "noun", "confidence": "medium", "frequencyRank": 1,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "feminine", "plural": "Wohnungen",
                },
                "junk": {
                    "source": "junk", "target": "Quatsch", "sourceGloss": "nonsense",
                    "partOfSpeech": "noun", "confidence": "medium", "frequencyRank": 2,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "masculine", "plural": "Quatsche",
                },
                "quick": {
                    "source": "quick", "target": "schnell", "sourceGloss": "quick",
                    "partOfSpeech": "adjective", "confidence": "medium", "frequencyRank": 3,
                    "sourceIds": ["seed"], "eligible": True,
                },
                "stable": {
                    "source": "stable", "target": "stabil", "sourceGloss": "stable",
                    "partOfSpeech": "adjective", "confidence": "high", "frequencyRank": 4,
                    "sourceIds": ["seed"], "eligible": True,
                },
                "unicorn": {
                    "source": "unicorn", "target": "Einhorn", "sourceGloss": "unicorn",
                    "partOfSpeech": "noun", "confidence": "medium", "frequencyRank": 5,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "neuter", "plural": "Einhörner",
                },
            },
        })
        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.tail.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {},
            "entries": {
                "gizmo": {
                    "source": "gizmo", "target": "Gerät", "sourceGloss": "gadget",
                    "partOfSpeech": "noun", "confidence": "low", "frequencyRank": 1_000_042,
                    "sourceIds": ["seed"], "enZipf": 2.1, "eligible": True,
                    "gender": "neuter", "plural": "Geräte",
                },
            },
        })

        # ---- audit queue: alternatives are the provenance ground truth ----
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"audit-{LANG}.jsonl", [
            {"lang": LANG, "key": "house", "source": "house", "target": "Wohnung", "pos": "noun",
             "alternatives": [
                 {"target": "Haus", "votes": 4, "sources": ["freedict", "omw"],
                  "morph": {"gender": "neuter", "plural": "Häuser", "authority": "wiktextract"}},
             ]},
            {"lang": LANG, "key": "junk", "source": "junk", "target": "Quatsch", "pos": "noun",
             "alternatives": [
                 {"target": "Unsinn", "votes": 3, "sources": ["freedict"], "morph": None},
             ]},
            {"lang": LANG, "key": "quick", "source": "quick", "target": "schnell", "pos": "adjective",
             "alternatives": [{"target": "rasch", "votes": 2, "sources": ["freedict"], "morph": None}]},
            {"lang": LANG, "key": "stable", "source": "stable", "target": "stabil", "pos": "adjective",
             "alternatives": []},
            {"lang": LANG, "key": "unicorn", "source": "unicorn", "target": "Einhorn", "pos": "noun",
             "alternatives": [{"target": "Fabeltier", "votes": 2, "sources": ["freedict"], "morph": None}]},
        ])

        # ---- mint queue ----
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"mint-{LANG}.jsonl", [
            {"lang": LANG, "key": "widget", "source": "widget", "enZipf": 3.2, "shipTierHint": "tail",
             "sourcePosCandidates": ["noun"], "sourcePos": "noun",
             "alternatives": [
                 {"target": "Gerätchen", "votes": 2, "sources": ["freedict", "omw"],
                  "morph": {"gender": "neuter", "plural": "Gerätchen", "authority": "wiktextract"}},
             ]},
            {"lang": LANG, "key": "vaporize", "source": "vaporize", "enZipf": 3.8, "shipTierHint": "core-gap",
             "sourcePosCandidates": ["verb"], "sourcePos": "verb",
             "alternatives": [
                 {"target": "verdampfen", "votes": 3, "sources": ["freedict", "omw", "apertium"], "morph": None},
             ]},
            {"lang": LANG, "key": "fizzle", "source": "fizzle", "enZipf": 4.9, "shipTierHint": "core-gap",
             "sourcePosCandidates": ["verb"], "sourcePos": "verb",
             "alternatives": [
                 {"target": "verpuffen", "votes": 2, "sources": ["freedict"], "morph": None},
                 {"target": "versanden", "votes": 1, "sources": ["omw"], "morph": None},
             ]},
            {"lang": LANG, "key": "obscuria", "source": "obscuria", "enZipf": 6.5, "shipTierHint": "core-gap",
             "sourcePosCandidates": ["verb"], "sourcePos": "verb",
             "alternatives": [
                 {"target": "verpuffen", "votes": 2, "sources": ["freedict"], "morph": None},
                 {"target": "versanden", "votes": 1, "sources": ["omw"], "morph": None},
             ]},
            {"lang": LANG, "key": "phantom", "source": "phantom", "enZipf": 2.5, "shipTierHint": "tail",
             "sourcePosCandidates": ["noun"], "sourcePos": "noun",
             "alternatives": [{"target": "Trugbild", "votes": 2, "sources": ["freedict"], "morph": None}]},
            {"lang": LANG, "key": "house", "source": "house", "enZipf": 5.0, "shipTierHint": "core-gap",
             "sourcePosCandidates": ["noun"], "sourcePos": "noun",
             "alternatives": [{"target": "Bau", "votes": 3, "sources": ["freedict", "omw", "apertium"], "morph": None}]},
        ])

        # ---- final verdict files (audit-de-0.jsonl, mint-de-0.jsonl) ----
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"audit-{LANG}-0.jsonl", [
            {"key": "house", "verdict": "retarget", "newTarget": "Haus", "newGender": "neuter",
             "newPlural": "Häuser", "morphAuthority": "wiktextract", "pos": "noun",
             "confidence": 0.95, "reason": "dominant sense is the dwelling", "refuter": "agree"},
            # judge will overturn this "keep" to "gate" via fixup
            {"key": "junk", "verdict": "keep", "pos": "noun", "confidence": 0.4,
             "reason": "uncertain", "refuter": "dispute", "refuterReason": "Quatsch is fine, actually gate anyway for test"},
            {"key": "quick", "verdict": "retarget", "newTarget": "zoom", "newGender": None,
             "newPlural": None, "morphAuthority": None, "pos": "adjective", "confidence": 0.8,
             "reason": "hallucinated target not in queue", "refuter": "unreviewed"},
            {"key": "stable", "verdict": "gate", "pos": "adjective", "confidence": 0.9,
             "reason": "not teachable", "refuter": "agree"},
            {"key": "unicorn", "verdict": "retarget", "newTarget": "Fabeltier", "newGender": None,
             "newPlural": None, "morphAuthority": None, "pos": "noun", "confidence": 0.7,
             "reason": "no morph authority for the alternative", "refuter": "unreviewed"},
        ])
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "fixup" / f"audit-{LANG}-0.jsonl", [
            {"key": "junk", "verdict": "gate", "pos": "noun", "confidence": 0.9,
             "reason": "judge overrules: gate it", "judge": "opus"},
        ])

        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"mint-{LANG}-0.jsonl", [
            {"key": "widget", "verdict": "mint", "target": "Gerätchen", "shipTier": "tail",
             "gender": "neuter", "plural": "Gerätchen", "morphAuthority": "wiktextract", "pos": "noun",
             "confidence": 0.85, "reason": "clean niche noun", "refuter": "agree"},
            {"key": "vaporize", "verdict": "mint", "target": "verdampfen", "shipTier": "core-gap",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.95, "reason": "unanimous 3-source agreement", "refuter": "agree"},
            {"key": "fizzle", "verdict": "mint", "target": "verpuffen", "shipTier": "core-gap",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.95, "reason": "not unanimous but still niche", "refuter": "agree"},
            {"key": "obscuria", "verdict": "mint", "target": "verpuffen", "shipTier": "core-gap",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.95, "reason": "not unanimous and too common for tail", "refuter": "agree"},
            {"key": "phantom", "verdict": "mint", "target": "Erscheinung", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "noun",
             "confidence": 0.6, "reason": "hallucinated target not in queue", "refuter": "unreviewed"},
            {"key": "house", "verdict": "mint", "target": "Bau", "shipTier": "core-gap",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "noun",
             "confidence": 0.95, "reason": "duplicate of an existing core key", "refuter": "agree"},
        ])

    def _read_packs(self):
        core = json.loads((self.tmp / "public" / "language-packs" / f"{LANG}.json").read_text())
        tail = json.loads((self.tmp / "public" / "language-packs" / f"{LANG}.tail.json").read_text())
        return core, tail

    def test_full_apply_run(self):
        report = apply_language(LANG, self.tmp)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["applied"], 2)
        self.assertEqual(report["skippedAlreadyApplied"], 0)

        core, tail = self._read_packs()
        core_e, tail_e = core["entries"], tail["entries"]

        # --- audit: retarget with valid provenance + morph ---
        self.assertEqual(core_e["house"]["target"], "Haus")
        self.assertEqual(core_e["house"]["gender"], "neuter")
        self.assertEqual(core_e["house"]["plural"], "Häuser")
        self.assertTrue(core_e["house"]["eligible"])

        # --- audit: fixup override wins (judge overturned keep -> gate) ---
        self.assertFalse(core_e["junk"]["eligible"])
        self.assertEqual(core_e["junk"]["target"], "Quatsch")  # unchanged, just gated

        # --- audit: retarget target not in queue alternatives -> downgraded to gate ---
        self.assertFalse(core_e["quick"]["eligible"])
        self.assertEqual(core_e["quick"]["target"], "schnell")  # unchanged

        # --- audit: plain gate ---
        self.assertFalse(core_e["stable"]["eligible"])

        # --- audit: retarget noun with no morph authority on the alternative -> gate ---
        self.assertFalse(core_e["unicorn"]["eligible"])
        self.assertEqual(core_e["unicorn"]["target"], "Einhorn")  # unchanged

        # --- mint: tail entry, rank continues from the existing tail max ---
        self.assertIn("widget", tail_e)
        self.assertEqual(tail_e["widget"]["target"], "Gerätchen")
        self.assertEqual(tail_e["widget"]["confidence"], "low")
        self.assertEqual(tail_e["widget"]["frequencyRank"], 1_000_043)  # existing max was 1_000_042
        self.assertEqual(tail_e["widget"]["gender"], "neuter")
        self.assertEqual(tail_e["widget"]["plural"], "Gerätchen")
        self.assertEqual(sorted(tail_e["widget"]["sourceIds"]), ["freedict", "omw"])

        # --- mint: unanimous >=3-source core-gap at confidence>=0.9 -> core, high ---
        self.assertIn("vaporize", core_e)
        self.assertEqual(core_e["vaporize"]["confidence"], "high")
        self.assertEqual(core_e["vaporize"]["frequencyRank"], 6)  # existing max core rank was 5
        self.assertNotIn("vaporize", tail_e)

        # --- mint: core-gap NOT unanimous, but enZipf<5 -> downgraded to tail ---
        self.assertIn("fizzle", tail_e)
        self.assertEqual(tail_e["fizzle"]["confidence"], "low")
        self.assertNotIn("fizzle", core_e)

        # --- mint: core-gap NOT unanimous AND enZipf>=5 -> dropped entirely ---
        self.assertNotIn("obscuria", core_e)
        self.assertNotIn("obscuria", tail_e)

        # --- mint: hallucinated target (not in queue alternatives) -> dropped ---
        self.assertNotIn("phantom", core_e)
        self.assertNotIn("phantom", tail_e)

        # --- mint: key collides with an existing core entry -> dropped ---
        self.assertEqual(core_e["house"]["target"], "Haus")  # untouched by the mint row

        # --- invariants sanity: core/tail disjoint, ranks unique ---
        self.assertEqual(set(core_e) & set(tail_e), set())
        core_ranks = [e["frequencyRank"] for e in core_e.values()]
        tail_ranks = [e["frequencyRank"] for e in tail_e.values()]
        self.assertEqual(len(core_ranks), len(set(core_ranks)))
        self.assertEqual(len(tail_ranks), len(set(tail_ranks)))
        for e in core_e.values():
            if e["partOfSpeech"] == "noun":
                self.assertIn("gender", e)
                self.assertIn("plural", e)
            else:
                self.assertNotIn("gender", e)
                self.assertNotIn("plural", e)

        # --- reject counters actually fired ---
        counts = report["counts"]
        self.assertEqual(counts.get("audit_retarget_no_provenance"), 1)
        self.assertEqual(counts.get("audit_retarget_no_morph"), 1)
        self.assertEqual(counts.get("mint_no_provenance"), 1)
        self.assertEqual(counts.get("mint_duplicate_key"), 1)
        self.assertEqual(counts.get("mint_core_gap_downgraded_tail"), 1)
        self.assertEqual(counts.get("mint_core_gap_dropped"), 1)

        # --- markers written ---
        applied_dir = self.tmp / "pipeline" / "data" / "verdicts" / "applied"
        self.assertTrue((applied_dir / f"audit-{LANG}-0.jsonl.done").exists())
        self.assertTrue((applied_dir / f"mint-{LANG}-0.jsonl.done").exists())

    def test_idempotent_rerun_skips_applied_files(self):
        first = apply_language(LANG, self.tmp)
        self.assertEqual(first["applied"], 2)

        core_after_first, tail_after_first = self._read_packs()

        second = apply_language(LANG, self.tmp)
        self.assertEqual(second["applied"], 0)
        self.assertEqual(second["skippedAlreadyApplied"], 2)

        core_after_second, tail_after_second = self._read_packs()
        self.assertEqual(core_after_first, core_after_second)
        self.assertEqual(tail_after_first, tail_after_second)

    def test_unsupported_language_is_rejected(self):
        report = apply_language("xx", self.tmp)
        self.assertFalse(report["ok"])

    def test_missing_core_pack_is_rejected(self):
        (self.tmp / "public" / "language-packs" / f"{LANG}.json").unlink()
        report = apply_language(LANG, self.tmp)
        self.assertFalse(report["ok"])


class ApplyVerdictsSourcePosAuthorizationTest(unittest.TestCase):
    """Mint POS is English queue provenance, never a target-side/LLM guess."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="apply-verdicts-source-pos-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {}, "entries": {},
        })

        def queue_row(key, candidates, alt_candidates=None, source_pos="__derive__"):
            alternative = {
                "target": f"{key}-target", "votes": 1,
                "sources": ["freedict"], "glosses": [], "morph": None,
                # Deliberately irrelevant to source-POS authorization.
                "pos": "adjective",
            }
            if alt_candidates is not None:
                alternative["sourcePosCandidates"] = alt_candidates
            row = {
                "lang": LANG, "key": key, "source": key, "enZipf": 3.0,
                "shipTierHint": "tail",
                "alternatives": [alternative],
            }
            if candidates is not None:  # None simulates a legacy queue row.
                row["sourcePosCandidates"] = candidates
                row["sourcePos"] = (candidates[0] if len(candidates) == 1 else None)
            if source_pos != "__derive__":
                row["sourcePos"] = source_pos
            return row

        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"mint-{LANG}.jsonl", [
            queue_row("authorized", ["adverb"]),
            queue_row("polysemous", ["noun", "verb"], ["verb"]),
            # Row-wide polysemy would allow adjective, but the exact selected
            # source-target pair authorizes only adverb.
            queue_row("wrongshape", ["adjective", "adverb"], ["adverb"]),
            queue_row("legacy", None),
        ])
        write_jsonl(
            self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"mint-{LANG}-0.jsonl",
            [
                {"key": "authorized", "verdict": "mint", "target": "authorized-target",
                 "shipTier": "tail", "pos": "adverb", "confidence": 0.9, "reason": "ok"},
                # sourcePos is null for genuine polysemy; membership in the
                # explicit candidate set is the authorization contract.
                {"key": "polysemous", "verdict": "mint", "target": "polysemous-target",
                 "shipTier": "tail", "pos": "verb", "confidence": 0.9, "reason": "ok"},
                # German target looks adjectival, but English source is only
                # authorized as adverb (the de-10027 failure mode).
                {"key": "wrongshape", "verdict": "mint", "target": "wrongshape-target",
                 "shipTier": "tail", "pos": "adjective", "confidence": 0.9, "reason": "bad"},
                # Old queue rows are not grandfathered: missing evidence fails closed.
                {"key": "legacy", "verdict": "mint", "target": "legacy-target",
                 "shipTier": "tail", "pos": "adjective", "confidence": 0.9, "reason": "bad"},
            ],
        )

    def test_only_queue_authorized_english_pos_can_mint(self):
        report = apply_language(LANG, self.tmp)
        self.assertTrue(report["ok"], report)
        tail = json.loads(
            (self.tmp / "public" / "language-packs" / f"{LANG}.tail.json").read_text()
        )["entries"]

        self.assertEqual(tail["authorized"]["partOfSpeech"], "adverb")
        self.assertEqual(tail["polysemous"]["partOfSpeech"], "verb")
        self.assertNotIn("wrongshape", tail)
        self.assertNotIn("legacy", tail)
        self.assertEqual(report["counts"].get("mint_pos_not_authorized"), 2)
        self.assertEqual(report["counts"].get("mint_tail"), 2)


class ApplyVerdictsShipStratumTest(unittest.TestCase):
    """Fixture self-test for --ship-stratum strict: a change (retarget/gate/
    mint) only applies when (refuter=="agree" OR the row is a judge ruling
    from fixup) AND confidence>=0.8; otherwise it must no-op exactly like
    keep/skip, regardless of what the verdict itself says."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="apply-verdicts-shipstratum-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {},
            "entries": {
                "keepcandidate1": {
                    "source": "keepcandidate1", "target": "oldA", "sourceGloss": "x",
                    "partOfSpeech": "adjective", "confidence": "medium", "frequencyRank": 1,
                    "sourceIds": ["seed"], "eligible": True,
                },
                "keepcandidate2": {
                    "source": "keepcandidate2", "target": "oldB", "sourceGloss": "x",
                    "partOfSpeech": "adjective", "confidence": "medium", "frequencyRank": 2,
                    "sourceIds": ["seed"], "eligible": True,
                },
                "gateblocked": {
                    "source": "gateblocked", "target": "oldC", "sourceGloss": "x",
                    "partOfSpeech": "adjective", "confidence": "medium", "frequencyRank": 3,
                    "sourceIds": ["seed"], "eligible": True,
                },
                "gateshipped": {
                    "source": "gateshipped", "target": "oldD", "sourceGloss": "x",
                    "partOfSpeech": "adjective", "confidence": "medium", "frequencyRank": 4,
                    "sourceIds": ["seed"], "eligible": True,
                },
            },
        })

        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"audit-{LANG}.jsonl", [
            {"lang": LANG, "key": "keepcandidate1", "source": "keepcandidate1", "target": "oldA",
             "pos": "adjective",
             "alternatives": [{"target": "newA", "votes": 2, "sources": ["freedict"], "morph": None}]},
            {"lang": LANG, "key": "keepcandidate2", "source": "keepcandidate2", "target": "oldB",
             "pos": "adjective",
             "alternatives": [{"target": "newB", "votes": 2, "sources": ["freedict"], "morph": None}]},
            {"lang": LANG, "key": "gateblocked", "source": "gateblocked", "target": "oldC",
             "pos": "adjective", "alternatives": []},
            {"lang": LANG, "key": "gateshipped", "source": "gateshipped", "target": "oldD",
             "pos": "adjective", "alternatives": []},
        ])

        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"audit-{LANG}-0.jsonl", [
            # ships: refuter agree + confidence>=0.8
            {"key": "keepcandidate1", "verdict": "retarget", "newTarget": "newA", "newGender": None,
             "newPlural": None, "morphAuthority": None, "pos": "adjective", "confidence": 0.9,
             "reason": "clears the bar", "refuter": "agree"},
            # blocked: disputed, no fixup judge ruling -> must no-op (stays "oldB")
            {"key": "keepcandidate2", "verdict": "retarget", "newTarget": "newB", "newGender": None,
             "newPlural": None, "morphAuthority": None, "pos": "adjective", "confidence": 0.9,
             "reason": "disputed, unresolved", "refuter": "dispute"},
            # blocked: refuter agree but confidence<0.8 -> must no-op (stays eligible)
            {"key": "gateblocked", "verdict": "gate", "pos": "adjective", "confidence": 0.5,
             "reason": "low confidence", "refuter": "agree"},
            # ships via judge ruling in fixup (no "refuter" field on the fixup row)
            {"key": "gateshipped", "verdict": "keep", "pos": "adjective", "confidence": 0.5,
             "reason": "will be overturned by judge", "refuter": "dispute"},
        ])
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "fixup" / f"audit-{LANG}-0.jsonl", [
            {"key": "gateshipped", "verdict": "gate", "pos": "adjective", "confidence": 0.85,
             "reason": "judge rules gate", "judge": "opus"},
        ])

        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"mint-{LANG}.jsonl", [
            {"lang": LANG, "key": "mintship", "source": "mintship", "enZipf": 3.0,
             "shipTierHint": "tail", "sourcePosCandidates": ["adjective"], "sourcePos": "adjective",
             "alternatives": [{"target": "mintedTarget", "votes": 2, "sources": ["freedict"], "morph": None}]},
            {"lang": LANG, "key": "mintblock", "source": "mintblock", "enZipf": 3.0,
             "shipTierHint": "tail", "sourcePosCandidates": ["adjective"], "sourcePos": "adjective",
             "alternatives": [{"target": "blockedTarget", "votes": 2, "sources": ["freedict"], "morph": None}]},
        ])
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"mint-{LANG}-0.jsonl", [
            {"key": "mintship", "verdict": "mint", "target": "mintedTarget", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "adjective",
             "confidence": 0.9, "reason": "clears the bar", "refuter": "agree"},
            {"key": "mintblock", "verdict": "mint", "target": "blockedTarget", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "adjective",
             "confidence": 0.9, "reason": "disputed, unresolved", "refuter": "dispute"},
        ])

    def _read_packs(self):
        core = json.loads((self.tmp / "public" / "language-packs" / f"{LANG}.json").read_text())
        tail_path = self.tmp / "public" / "language-packs" / f"{LANG}.tail.json"
        tail = json.loads(tail_path.read_text()) if tail_path.exists() else {"entries": {}}
        return core, tail

    def test_strict_only_ships_refuter_agree_or_judge_ruled_at_confidence_0_8(self):
        report = apply_language(LANG, self.tmp, ship_stratum="strict")
        self.assertTrue(report["ok"], report)

        core, tail = self._read_packs()
        core_e, tail_e = core["entries"], tail["entries"]

        # --- retarget: refuter agree + confidence 0.9 -> ships ---
        self.assertEqual(core_e["keepcandidate1"]["target"], "newA")
        self.assertTrue(core_e["keepcandidate1"]["eligible"])

        # --- retarget: disputed, no judge ruling -> no-op (unchanged) ---
        self.assertEqual(core_e["keepcandidate2"]["target"], "oldB")
        self.assertTrue(core_e["keepcandidate2"]["eligible"])

        # --- gate: refuter agree but confidence<0.8 -> no-op (still eligible) ---
        self.assertTrue(core_e["gateblocked"]["eligible"])

        # --- gate: judge ruling in fixup, confidence 0.85 -> ships ---
        self.assertFalse(core_e["gateshipped"]["eligible"])

        # --- mint: refuter agree + confidence 0.9 -> ships (into tail) ---
        self.assertIn("mintship", tail_e)
        self.assertNotIn("mintship", core_e)

        # --- mint: disputed, no judge ruling -> no-op (never minted) ---
        self.assertNotIn("mintblock", core_e)
        self.assertNotIn("mintblock", tail_e)

        counts = report["counts"]
        self.assertEqual(counts.get("audit_shipstratum_noop"), 2)  # keepcandidate2 + gateblocked
        self.assertEqual(counts.get("mint_shipstratum_noop"), 1)  # mintblock
        self.assertEqual(counts.get("audit_gate"), 1)  # only gateshipped (judge-ruled) applies
        self.assertEqual(counts.get("audit_retarget"), 1)
        self.assertEqual(counts.get("mint_tail"), 1)

    def test_default_no_ship_stratum_applies_every_verdict_regardless_of_refuter(self):
        """Same fixture, no --ship-stratum flag: existing (pre-patch) behavior
        is unchanged -- every verdict applies on its own terms."""
        report = apply_language(LANG, self.tmp)
        self.assertTrue(report["ok"], report)

        core, tail = self._read_packs()
        core_e, tail_e = core["entries"], tail["entries"]

        self.assertEqual(core_e["keepcandidate1"]["target"], "newA")
        self.assertEqual(core_e["keepcandidate2"]["target"], "newB")  # applied despite dispute
        self.assertFalse(core_e["gateblocked"]["eligible"])  # gated despite low confidence
        self.assertFalse(core_e["gateshipped"]["eligible"])
        self.assertIn("mintship", tail_e)
        self.assertIn("mintblock", tail_e)  # minted despite dispute

        counts = report["counts"]
        self.assertIsNone(counts.get("audit_shipstratum_noop"))
        self.assertIsNone(counts.get("mint_shipstratum_noop"))


class ApplyVerdictsMintOnlyAndMinttrialTest(unittest.TestCase):
    """--mint-only must never touch audit-*.jsonl, and a key sampled into both
    minttrial-mixed and the plain mint-{lang} queue must be won by the
    minttrial (panel-verified) verdict, applied idempotently per language."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="apply-verdicts-mintonly-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {}, "entries": {},
        })

        # audit queue + verdict present, but --mint-only must skip it entirely
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"audit-{LANG}.jsonl", [
            {"lang": LANG, "key": "house", "source": "house", "target": "Wohnung", "pos": "noun",
             "alternatives": [{"target": "Haus", "votes": 4, "sources": ["freedict"],
                                "morph": {"gender": "neuter", "plural": "Häuser", "authority": "wiktextract"}}]},
        ])
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"audit-{LANG}-0.jsonl", [
            {"key": "house", "verdict": "gate", "pos": "noun", "confidence": 0.9,
             "reason": "should never be applied under --mint-only", "refuter": "agree"},
        ])

        # "overlap" is sampled into BOTH mint-de and minttrial-mixed (as build_minttrial_sample.py
        # does: minttrial rows are drawn straight from the mint-{lang} queue).
        overlap_record = {"lang": LANG, "key": "overlap", "source": "overlap", "enZipf": 3.0,
                           "shipTierHint": "tail", "sourcePosCandidates": ["verb"], "sourcePos": "verb",
                           "alternatives": [{"target": "trialTarget", "votes": 2, "sources": ["freedict"], "morph": None},
                                            {"target": "batchTarget", "votes": 2, "sources": ["freedict"], "morph": None}]}
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"mint-{LANG}.jsonl", [overlap_record])
        # minttrial-mixed carries other languages' rows too -- these must be
        # ignored (not rejected/counted) when applying language=de.
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / "minttrial-mixed.jsonl", [
            {"lang": "fr", "key": "bonjour", "source": "bonjour", "enZipf": 3.0, "shipTierHint": "tail",
             "sourcePosCandidates": ["verb"], "sourcePos": "verb",
             "alternatives": [{"target": "hello", "votes": 2, "sources": ["freedict"], "morph": None}]},
            dict(overlap_record),
        ])

        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"mint-{LANG}-0.jsonl", [
            {"key": "overlap", "verdict": "mint", "target": "batchTarget", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.7, "reason": "plain batch verdict -- should lose to minttrial", "refuter": "agree"},
        ])
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / "minttrial-mixed-0.jsonl", [
            {"key": "bonjour", "verdict": "mint", "target": "salut", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.9, "reason": "fr row, must not affect a de run", "refuter": "agree"},
            {"key": "overlap", "verdict": "mint", "target": "trialTarget", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.9, "reason": "panel-verified trial verdict -- should win", "refuter": "agree"},
        ])

    def _read_packs(self):
        core = json.loads((self.tmp / "public" / "language-packs" / f"{LANG}.json").read_text())
        tail_path = self.tmp / "public" / "language-packs" / f"{LANG}.tail.json"
        tail = json.loads(tail_path.read_text()) if tail_path.exists() else {"entries": {}}
        return core, tail

    def test_mint_only_skips_audit_and_minttrial_wins_dedupe(self):
        report = apply_language(LANG, self.tmp, mint_only=True)
        self.assertTrue(report["ok"], report)

        core, tail = self._read_packs()
        core_e, tail_e = core["entries"], tail["entries"]

        # audit-de-0.jsonl never applied under --mint-only
        self.assertNotIn("house", core_e)
        self.assertNotIn("house", tail_e)
        self.assertNotIn(f"audit-{LANG}-0.jsonl.done", report["appliedFiles"])

        # minttrial's target wins over the plain mint-de batch's target
        self.assertIn("overlap", tail_e)
        self.assertEqual(tail_e["overlap"]["target"], "trialTarget")
        self.assertNotIn("overlap", core_e)

        # the fr row in the shared minttrial-mixed file must not leak into a de run
        self.assertNotIn("bonjour", core_e)
        self.assertNotIn("bonjour", tail_e)

        # The plain mint-de row for "overlap" is preemptively excluded (not a
        # reject-then-duplicate-key race) because minttrial covers that key,
        # regardless of whether minttrial's own verdict was mint or skip.
        counts = report["counts"]
        self.assertEqual(counts.get("mint_superseded_by_minttrial"), 1)
        self.assertIsNone(counts.get("mint_duplicate_key"))
        self.assertIsNone(counts.get("audit_gate"))

        applied_dir = self.tmp / "pipeline" / "data" / "verdicts" / "applied"
        self.assertTrue((applied_dir / f"minttrial-mixed-0.jsonl.{LANG}.done").exists())
        self.assertFalse((applied_dir / "minttrial-mixed-0.jsonl.done").exists())
        self.assertFalse((applied_dir / f"audit-{LANG}-0.jsonl.done").exists())

    def test_minttrial_skip_also_blocks_the_plain_mint_verdict_for_that_key(self):
        """Regression: minttrial must win even when its own verdict is "skip" --
        the plain mint-{lang} row for the same key must NOT sneak through just
        because skip doesn't occupy the key the way a mint would."""
        tmp = Path(tempfile.mkdtemp(prefix="apply-verdicts-minttrial-skip-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)

        write_json(tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {}, "entries": {},
        })
        overlap_record = {"lang": LANG, "key": "overlap", "source": "overlap", "enZipf": 3.0,
                           "shipTierHint": "tail", "sourcePosCandidates": ["verb"], "sourcePos": "verb",
                           "alternatives": [{"target": "batchTarget", "votes": 2, "sources": ["freedict"], "morph": None}]}
        write_jsonl(tmp / "pipeline" / "data" / "queues" / f"mint-{LANG}.jsonl", [overlap_record])
        write_jsonl(tmp / "pipeline" / "data" / "queues" / "minttrial-mixed.jsonl", [dict(overlap_record)])

        write_jsonl(tmp / "pipeline" / "data" / "verdicts" / "final" / f"mint-{LANG}-0.jsonl", [
            {"key": "overlap", "verdict": "mint", "target": "batchTarget", "shipTier": "tail",
             "gender": None, "plural": None, "morphAuthority": None, "pos": "verb",
             "confidence": 0.9, "reason": "plain batch says mint -- must still lose", "refuter": "agree"},
        ])
        write_jsonl(tmp / "pipeline" / "data" / "verdicts" / "final" / "minttrial-mixed-0.jsonl", [
            {"key": "overlap", "verdict": "skip", "target": None, "shipTier": None,
             "gender": None, "plural": None, "morphAuthority": None, "pos": None,
             "confidence": 0.9, "reason": "panel-verified: not teachable", "refuter": "agree"},
        ])

        report = apply_language(LANG, tmp, mint_only=True)
        self.assertTrue(report["ok"], report)

        core = json.loads((tmp / "public" / "language-packs" / f"{LANG}.json").read_text())
        tail_path = tmp / "public" / "language-packs" / f"{LANG}.tail.json"
        tail = json.loads(tail_path.read_text()) if tail_path.exists() else {"entries": {}}

        self.assertNotIn("overlap", core["entries"])
        self.assertNotIn("overlap", tail.get("entries", {}))
        self.assertEqual(report["counts"].get("mint_superseded_by_minttrial"), 1)
        self.assertIsNone(report["counts"].get("mint_tail"))

    def test_rerun_is_idempotent_and_language_scoped_marker_does_not_collide(self):
        first = apply_language(LANG, self.tmp, mint_only=True)
        self.assertEqual(first["applied"], 2)  # minttrial-mixed-0 (de rows) + mint-de-0

        second = apply_language(LANG, self.tmp, mint_only=True)
        self.assertEqual(second["applied"], 0)
        self.assertEqual(second["skippedAlreadyApplied"], 2)

        # A different language's applied/ marker for the SAME shared minttrial
        # file must be independent -- simulate an "it" run against its own
        # (empty) it-language slice of the same minttrial-mixed file.
        write_json(self.tmp / "public" / "language-packs" / "it.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": "it",
            "displayName": "Italian", "sources": {}, "entries": {},
        })
        it_report = apply_language("it", self.tmp, mint_only=True)
        self.assertTrue(it_report["ok"], it_report)
        # it has no rows in minttrial-mixed-0 or mint-it-0 (queue file absent),
        # but the file must still be considered visited/applied for "it", under
        # its own marker, independent of the "de" marker already on disk.
        applied_dir = self.tmp / "pipeline" / "data" / "verdicts" / "applied"
        self.assertTrue((applied_dir / "minttrial-mixed-0.jsonl.it.done").exists())
        self.assertTrue((applied_dir / f"minttrial-mixed-0.jsonl.{LANG}.done").exists())


class ReglossVerdictsFixtureTest(unittest.TestCase):
    """Regloss verdicts: sourceGloss replacement with queue-provenance checks."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="apply-regloss-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {},
            "entries": {
                "version": {
                    "source": "version", "target": "Version", "sourceGloss": "software release",
                    "partOfSpeech": "noun", "confidence": "high", "frequencyRank": 1,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "feminine", "plural": "Versionen",
                },
                "court": {
                    "source": "court", "target": "Gericht", "sourceGloss": "institution deciding legal disputes",
                    "partOfSpeech": "noun", "confidence": "high", "frequencyRank": 2,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "neuter", "plural": "Gerichte",
                },
                "charge": {
                    "source": "charge", "target": "Anklage", "sourceGloss": "formal criminal accusation",
                    "partOfSpeech": "noun", "confidence": "high", "frequencyRank": 3,
                    "sourceIds": ["seed"], "eligible": True,
                    "gender": "feminine", "plural": "Anklagen",
                },
            },
        })
        write_json(self.tmp / "public" / "language-packs" / f"{LANG}.tail.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": LANG,
            "displayName": "German", "sources": {}, "entries": {},
        })

        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"regloss-{LANG}.jsonl", [
            {"key": "version", "source": "version", "target": "Version", "pos": "noun",
             "currentGloss": "software release", "enZipf": 5.07,
             "candidateGlosses": [
                 {"gloss": "A specific form or variation of something.", "tableSize": 6, "aligned": True},
             ],
             "glossSourceId": "regloss-sense-aligned"},
            {"key": "court", "source": "court", "target": "Gericht", "pos": "noun",
             "currentGloss": "institution deciding legal disputes", "enZipf": 5.41,
             "candidateGlosses": [
                 {"gloss": "The administration of law.", "tableSize": 5, "aligned": True},
             ],
             "glossSourceId": "regloss-sense-aligned"},
            {"key": "charge", "source": "charge", "target": "Anklage", "pos": "noun",
             "currentGloss": "formal criminal accusation", "enZipf": 5.2,
             "candidateGlosses": [
                 {"gloss": "An accusation.", "tableSize": 4, "aligned": True},
             ],
             "glossSourceId": "regloss-sense-aligned"},
        ])

    def run_verdicts(self, rows, ship_stratum=None):
        write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / f"regloss-{LANG}-0.jsonl", rows)
        return apply_language(LANG, self.tmp, ship_stratum)

    def entries(self):
        pack = json.loads((self.tmp / "public" / "language-packs" / f"{LANG}.json").read_text())
        return pack["entries"]

    def test_regloss_replaces_gloss_and_records_provenance(self):
        report = self.run_verdicts([
            {"key": "version", "verdict": "regloss",
             "newGloss": "A specific form or variation of something.",
             "confidence": 0.95, "refuter": "agree", "reason": "dominant sense"},
            {"key": "court", "verdict": "keep", "confidence": 0.9, "refuter": "agree"},
        ])
        self.assertTrue(report["ok"])
        self.assertEqual(report["counts"].get("regloss_applied"), 1)
        self.assertEqual(report["counts"].get("regloss_keep"), 1)
        entries = self.entries()
        self.assertEqual(entries["version"]["sourceGloss"], "A specific form or variation of something.")
        self.assertIn("regloss-sense-aligned", entries["version"]["sourceIds"])
        self.assertEqual(entries["court"]["sourceGloss"], "institution deciding legal disputes")

    def test_invented_gloss_is_rejected(self):
        report = self.run_verdicts([
            {"key": "version", "verdict": "regloss",
             "newGloss": "A totally made-up definition.",
             "confidence": 0.95, "refuter": "agree", "reason": "hallucinated"},
        ])
        self.assertEqual(report["counts"].get("regloss_no_provenance"), 1)
        self.assertEqual(self.entries()["version"]["sourceGloss"], "software release")

    def test_missing_entry_is_rejected(self):
        report = self.run_verdicts([
            {"key": "ghost", "verdict": "regloss", "newGloss": "Anything.",
             "confidence": 0.95, "refuter": "agree"},
        ])
        self.assertEqual(report["counts"].get("regloss_missing_entry"), 1)

    def test_strict_stratum_noops_unconfirmed_rows(self):
        report = self.run_verdicts([
            # No refuter agreement: strict must treat it as keep.
            {"key": "version", "verdict": "regloss",
             "newGloss": "A specific form or variation of something.",
             "confidence": 0.95, "refuter": "disagree"},
            # Refuter-agreed at high confidence: ships.
            {"key": "charge", "verdict": "regloss",
             "newGloss": "An accusation.",
             "confidence": 0.9, "refuter": "agree"},
        ], ship_stratum="strict")
        self.assertEqual(report["counts"].get("regloss_shipstratum_noop"), 1)
        self.assertEqual(report["counts"].get("regloss_applied"), 1)
        entries = self.entries()
        self.assertEqual(entries["version"]["sourceGloss"], "software release")
        self.assertEqual(entries["charge"]["sourceGloss"], "An accusation.")

    def test_stale_target_is_rejected(self):
        # The queue aligned its candidates against target "Version"; simulate a
        # retarget landing in between by rewriting the entry's target first.
        pack_path = self.tmp / "public" / "language-packs" / f"{LANG}.json"
        pack = json.loads(pack_path.read_text())
        pack["entries"]["version"]["target"] = "Fassung"
        write_json(pack_path, pack)

        report = self.run_verdicts([
            {"key": "version", "verdict": "regloss",
             "newGloss": "A specific form or variation of something.",
             "confidence": 0.95, "refuter": "agree"},
        ])
        self.assertEqual(report["counts"].get("regloss_stale_target"), 1)
        self.assertEqual(self.entries()["version"]["sourceGloss"], "software release")

    def test_truncated_list_intro_gloss_is_rejected_even_with_provenance(self):
        # Defense in depth: even a queue-listed candidate must not ship a
        # dangling "such as:" gloss.
        write_jsonl(self.tmp / "pipeline" / "data" / "queues" / f"regloss-{LANG}.jsonl", [
            {"key": "version", "source": "version", "target": "Version", "pos": "noun",
             "currentGloss": "software release", "enZipf": 5.07,
             "candidateGlosses": [{"gloss": "A rule, such as:", "tableSize": 6, "aligned": True}],
             "glossSourceId": "regloss-sense-aligned"},
        ])
        report = self.run_verdicts([
            {"key": "version", "verdict": "regloss", "newGloss": "A rule, such as:",
             "confidence": 0.95, "refuter": "agree"},
        ])
        self.assertEqual(report["counts"].get("regloss_bad_gloss"), 1)
        self.assertEqual(self.entries()["version"]["sourceGloss"], "software release")

    def test_rerun_is_idempotent(self):
        rows = [{"key": "version", "verdict": "regloss",
                 "newGloss": "A specific form or variation of something.",
                 "confidence": 0.95, "refuter": "agree"}]
        first = self.run_verdicts(rows)
        self.assertEqual(first["counts"].get("regloss_applied"), 1)
        second = apply_language(LANG, self.tmp)
        self.assertNotIn("regloss_applied", second["counts"])
        self.assertGreaterEqual(second["skippedAlreadyApplied"], 1)



if __name__ == "__main__":
    unittest.main()
