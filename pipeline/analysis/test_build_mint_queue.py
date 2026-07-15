"""Focused unit tests for the mint-queue volume levers.

Covers the three shipped levers plus the un-shipped measurement:
  - the STRICT gloss-match (wiktgloss) agreement matcher, incl. the negatives
    that keep it precise (multi-sense / "related to X" / parenthetical glosses);
  - per-field morphology composition (wikidata gender + wiktextract plural);
  - the --min-votes gate threshold and the wiktgloss unlock at >=2;
  - that a composed "wikidata+wiktextract" authority string survives apply_verdicts.

Run directly:  python3 -m unittest pipeline.analysis.test_build_mint_queue
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pipeline.analysis import build_mint_queue as bmq
from pipeline.analysis.apply_verdicts import apply_language


def make_indexes(*, freedict=None, apertium=None, omw=None, entr=None,
                 wikidata=None, wikt_noun=None, wikt_gloss=None, wikt_match_gloss=None):
    """Assemble the `indexes` dict build_alternatives_and_check_gate expects, with
    empty defaults so a test only has to specify the sources it cares about."""
    return {
        "freedict": freedict or {},
        "apertium": apertium or {},
        "omw": omw or {},
        "entr": entr or {},
        "wikidata": wikidata or {},
        "wikt_noun": wikt_noun or {},
        "wikt_gloss": wikt_gloss or {},
        "wikt_match_gloss": wikt_match_gloss or {},
    }


def entr_bucket(lang, target, gloss="gloss", pos="noun"):
    return [{"pos": pos, "gloss": gloss, "tr": [[lang, target, []]]}]


class StrictGlossMatcherTest(unittest.TestCase):
    def test_positive_exact_and_article(self):
        self.assertTrue(bmq.gloss_matches_word_strict("dog", "dog"))
        self.assertTrue(bmq.gloss_matches_word_strict("the house", "house"))
        self.assertTrue(bmq.gloss_matches_word_strict("a dog", "dog"))
        self.assertTrue(bmq.gloss_matches_word_strict("An Owl", "owl"))
        self.assertTrue(bmq.gloss_matches_word_strict("dog.", "dog"))  # trailing punct

    def test_positive_comma_semicolon_segments(self):
        self.assertTrue(bmq.gloss_matches_word_strict("dog; hound", "hound"))
        self.assertTrue(bmq.gloss_matches_word_strict("big, large", "large"))
        self.assertTrue(bmq.gloss_matches_word_strict("a cat; a feline", "feline"))

    def test_negative_definitional_glosses(self):
        # "related to X" style definitional glosses must NOT match.
        self.assertFalse(bmq.gloss_matches_word_strict("related to war", "war"))
        self.assertFalse(bmq.gloss_matches_word_strict("a kind of dog", "dog"))
        self.assertFalse(bmq.gloss_matches_word_strict("pertaining to the sea", "sea"))

    def test_negative_multisense_and_parenthetical(self):
        # A multi-sense definitional segment doesn't reduce to the bare lemma.
        self.assertFalse(bmq.gloss_matches_word_strict("a mammal, specifically a dog", "dog"))
        # Parentheticals are deliberately NOT stripped (precision-first).
        self.assertFalse(bmq.gloss_matches_word_strict("foot (a part of the body)", "foot"))

    def test_negative_substring_is_not_a_match(self):
        self.assertFalse(bmq.gloss_matches_word_strict("doghouse", "dog"))
        self.assertFalse(bmq.gloss_matches_word_strict("watchdog", "dog"))

    def test_tokencontains_is_a_strict_superset(self):
        # token-contains (MEASUREMENT only) catches what strict deliberately drops.
        self.assertTrue(bmq.gloss_tokencontains_word("foot (a part of the body)", "foot"))
        self.assertTrue(bmq.gloss_tokencontains_word("related to war", "war"))
        # ...but is still token-boundaried: no substring matches.
        self.assertFalse(bmq.gloss_tokencontains_word("doghouse", "dog"))


class ComposeMorphTest(unittest.TestCase):
    def test_wikidata_gender_wiktextract_plural(self):
        # The headline fix: wikidata has gender but NULL plural -> compose the
        # plural in from wiktextract instead of dropping the noun.
        got = bmq.compose_morph([("masculine", None)], [(None, "perros")])
        self.assertEqual(got, {"gender": "masculine", "plural": "perros",
                               "authority": "wikidata+wiktextract"})

    def test_wikidata_only(self):
        got = bmq.compose_morph([("feminine", "casas")], [])
        self.assertEqual(got, {"gender": "feminine", "plural": "casas", "authority": "wikidata"})

    def test_wiktextract_only(self):
        got = bmq.compose_morph([], [("neuter", "Häuser")])
        self.assertEqual(got, {"gender": "neuter", "plural": "Häuser", "authority": "wiktextract"})

    def test_wikidata_wins_gender_when_both_present(self):
        got = bmq.compose_morph([("masculine", "los")], [("feminine", "las")])
        self.assertEqual(got["gender"], "masculine")
        self.assertEqual(got["plural"], "los")
        self.assertEqual(got["authority"], "wikidata")

    def test_none_when_no_signal(self):
        self.assertIsNone(bmq.compose_morph([], []))
        self.assertIsNone(bmq.compose_morph([(None, None)], [(None, None)]))

    def test_most_common_non_null_field(self):
        # gender picks the most-common non-null value.
        got = bmq.compose_morph([("masculine", None), ("masculine", None), ("feminine", None)], [])
        self.assertEqual(got["gender"], "masculine")


class MinVotesGateTest(unittest.TestCase):
    def test_entr_only_gate_flips_with_min_votes(self):
        idx = make_indexes(entr={"aardvark": entr_bucket("de", "Erdferkel")})
        alts2, keys2, passes2, diag2 = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertFalse(passes2)
        self.assertEqual(diag2["trueBest"], 1)
        self.assertEqual(diag2["strictBest"], 1)

        alts1, keys1, passes1, diag1 = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=1)
        self.assertTrue(passes1)
        self.assertEqual([a["target"] for a in alts1], ["Erdferkel"])

    def test_two_real_sources_pass_at_two(self):
        idx = make_indexes(
            apertium={"cat": ["Katze"]},
            entr={"cat": entr_bucket("de", "Katze")},
        )
        _, _, passes, diag = bmq.build_alternatives_and_check_gate("de", "cat", idx, min_votes=2)
        self.assertTrue(passes)
        self.assertEqual(diag["trueBest"], 2)


class WiktglossVoteTest(unittest.TestCase):
    def test_wiktgloss_unlocks_entr_only_at_two(self):
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            wikt_match_gloss={"erdferkel": ["aardvark"]},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertTrue(passes)                      # reached the 2-vote gate...
        self.assertEqual(diag["trueBest"], 1)        # ...but only 1 REAL dictionary vote
        self.assertEqual(diag["strictBest"], 2)
        self.assertIn("wiktgloss", alts[0]["sources"])
        self.assertEqual(alts[0]["votes"], 2)

    def test_wiktgloss_never_invents_an_alternative(self):
        # A lemma that only appears in the gloss index (no real source proposed
        # it) must never become an alternative.
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            wikt_match_gloss={"zebra": ["aardvark"], "erdferkel": []},
        )
        alts, _, _, _ = bmq.build_alternatives_and_check_gate("de", "aardvark", idx, min_votes=1)
        self.assertEqual([a["target"] for a in alts], ["Erdferkel"])
        self.assertNotIn("wiktgloss", alts[0]["sources"])

    def test_tokencontains_delta_measured_but_not_shipped(self):
        # A parenthetical gloss: token-contains would confirm it, strict does not,
        # so no wiktgloss vote is added but tcBest records the missed unlock.
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            wikt_match_gloss={"erdferkel": ["an aardvark (mammal)"]},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertFalse(passes)                     # strict did NOT unlock it
        self.assertEqual(diag["strictBest"], 1)
        self.assertEqual(diag["tcBest"], 2)          # token-contains WOULD have
        self.assertNotIn("wiktgloss", alts[0]["sources"])

    def test_composed_morph_flows_into_alternative(self):
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            apertium={"aardvark": ["Erdferkel"]},
            wikidata={"erdferkel": [("neuter", None)]},   # gender, NULL plural
            wikt_noun={"erdferkel": [("neuter", "Erdferkel")]},  # plural from wiktextract
        )
        alts, _, passes, _ = bmq.build_alternatives_and_check_gate("de", "aardvark", idx, min_votes=2)
        self.assertTrue(passes)
        self.assertEqual(alts[0]["morph"],
                         {"gender": "neuter", "plural": "Erdferkel",
                          "authority": "wikidata+wiktextract"})


def _write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")


class ComposedAuthorityAcceptedByApplyVerdictsTest(unittest.TestCase):
    """apply_verdicts re-derives gender/plural from the queue alternative's morph;
    a composed 'wikidata+wiktextract' authority string must not break minting."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mint-authority-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        _write_json(self.tmp / "public" / "language-packs" / "de.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": "de",
            "displayName": "German", "sources": {},
            "entries": {"seedword": {
                "source": "seedword", "target": "Saat", "sourceGloss": "seed",
                "partOfSpeech": "noun", "confidence": "medium", "frequencyRank": 1,
                "sourceIds": ["seed"], "eligible": True, "gender": "feminine", "plural": "Saaten",
            }},
        })
        _write_json(self.tmp / "public" / "language-packs" / "de.tail.json", {
            "version": "test", "sourceLanguage": "en", "targetLanguage": "de",
            "displayName": "German", "sources": {}, "entries": {},
        })
        _write_jsonl(self.tmp / "pipeline" / "data" / "queues" / "mint-de.jsonl", [
            {"lang": "de", "key": "aardvark", "source": "aardvark", "enZipf": 3.0,
             "shipTierHint": "tail",
             "alternatives": [{
                 "target": "Erdferkel", "votes": 2, "sources": ["entr", "wiktgloss"],
                 "omwBestSenseRank": None, "glosses": ["Erdferkel"],
                 "morph": {"gender": "neuter", "plural": "Erdferkel",
                           "authority": "wikidata+wiktextract"},
             }]},
        ])
        _write_jsonl(self.tmp / "pipeline" / "data" / "verdicts" / "final" / "mint-de-0.jsonl", [
            {"key": "aardvark", "verdict": "mint", "target": "Erdferkel", "shipTier": "tail",
             "pos": "noun", "gender": "neuter", "plural": "Erdferkel",
             "morphAuthority": "wikidata+wiktextract", "confidence": 0.95, "reason": "test"},
        ])

    def test_mints_with_composed_authority(self):
        report = apply_language("de", root=self.tmp)
        self.assertTrue(report["ok"], report)
        tail = json.loads((self.tmp / "public" / "language-packs" / "de.tail.json").read_text())
        self.assertIn("aardvark", tail["entries"])
        entry = tail["entries"]["aardvark"]
        self.assertEqual(entry["gender"], "neuter")
        self.assertEqual(entry["plural"], "Erdferkel")
        self.assertEqual(entry["target"], "Erdferkel")
        # No mint reject was counted.
        self.assertEqual(report["counts"].get("mint_tail"), 1, report["counts"])


if __name__ == "__main__":
    unittest.main()
