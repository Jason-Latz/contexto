import json
import tempfile
import unittest
from pathlib import Path

from pipeline.import_wikt.extract import (
    Candidate,
    _clean_pieces,
    _derive_french_plural,
    _gender_of,
    _is_form_of,
    _plural_of,
    _restricted_penalty,
    _valid_target,
    iter_candidates,
)
from pipeline.import_wikt.build import to_entry


def pieces(gloss):
    return list(_clean_pieces(gloss))


class CleanPiecesTest(unittest.TestCase):
    def test_splits_synonym_lists(self):
        self.assertEqual(pieces("dog; hound"), [("dog", 1), ("hound", 1)])
        self.assertEqual(pieces("big, large"), [("big", 1), ("large", 1)])

    def test_strips_infinitive_marker(self):
        # Without this, "to run" would be a 2-word phrase blocked by the "to" stopword.
        self.assertEqual(pieces("to run"), [("run", 1)])

    def test_strips_leading_article(self):
        self.assertEqual(pieces("a house"), [("house", 1)])

    def test_drops_english_function_words(self):
        self.assertEqual(pieces("the"), [])
        self.assertEqual(pieces("of"), [])

    def test_drops_single_letters(self):
        self.assertEqual(pieces("i"), [])

    def test_keeps_clean_two_word_expression(self):
        self.assertEqual(pieces("ice cream"), [("ice cream", 2)])

    def test_drops_definitional_phrases(self):
        self.assertEqual(pieces("kind of fish"), [])  # 'of', 'kind' are stopwords
        self.assertEqual(pieces("why don't you"), [])


class GenderPluralTest(unittest.TestCase):
    def test_gender_from_sense_tags(self):
        self.assertEqual(_gender_of({"senses": [{"tags": ["neuter"]}]}), "neuter")

    def test_gender_from_head_template(self):
        rec = {"head_templates": [{"args": {"1": "f"}}], "senses": []}
        self.assertEqual(_gender_of(rec), "feminine")

    def test_gender_absent(self):
        self.assertIsNone(_gender_of({"senses": [{"tags": ["plural"]}]}))

    def test_plural_form(self):
        rec = {"forms": [{"form": "Hunde", "tags": ["plural"]}]}
        self.assertEqual(_plural_of(rec), "Hunde")

    def test_plural_skips_singular_and_markers(self):
        rec = {"forms": [
            {"form": "x", "tags": ["plural", "singular"]},
            {"form": "-", "tags": ["plural"]},
            {"form": "Häuser", "tags": ["plural"]},
        ]}
        self.assertEqual(_plural_of(rec), "Häuser")


class FrenchPluralTest(unittest.TestCase):
    def test_regular(self):
        self.assertEqual(_derive_french_plural("chat"), "chats")

    def test_invariable_sxz(self):
        self.assertEqual(_derive_french_plural("bras"), "bras")
        self.assertEqual(_derive_french_plural("nez"), "nez")

    def test_al_to_aux(self):
        self.assertEqual(_derive_french_plural("cheval"), "chevaux")

    def test_eau_adds_x(self):
        self.assertEqual(_derive_french_plural("bateau"), "bateaux")


class MiscHelpersTest(unittest.TestCase):
    def test_is_form_of(self):
        self.assertTrue(_is_form_of({"tags": ["form-of"]}))
        self.assertTrue(_is_form_of({"form_of": [{"word": "x"}]}))
        self.assertFalse(_is_form_of({"tags": ["masculine"]}))

    def test_restricted_penalty(self):
        self.assertEqual(_restricted_penalty({"tags": ["vulgar"]}), 2.0)
        self.assertEqual(_restricted_penalty({"tags": ["masculine"]}), 0.0)

    def test_valid_target(self):
        self.assertTrue(_valid_target("Hund"))
        self.assertFalse(_valid_target("h2o"))
        self.assertFalse(_valid_target("-suffix"))


def _write_jsonl(records):
    tmp = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    for rec in records:
        tmp.write(json.dumps(rec) + "\n")
    tmp.close()
    return tmp.name


class IterCandidatesTest(unittest.TestCase):
    def _candidates(self, records, language="de"):
        path = _write_jsonl(records)
        try:
            return list(iter_candidates(path, lambda w: 4.0, language))
        finally:
            Path(path).unlink()

    def test_noun_inversion_with_gender_plural_and_synonyms(self):
        cands = self._candidates([{
            "pos": "noun", "word": "Hund",
            "forms": [{"form": "Hunde", "tags": ["plural"]}],
            "senses": [{"glosses": ["dog; hound"], "tags": ["masculine"]}],
        }])
        by_source = {c.source: c for c in cands}
        self.assertIn("dog", by_source)
        self.assertIn("hound", by_source)
        self.assertEqual(by_source["dog"].target, "Hund")
        self.assertEqual(by_source["dog"].gender, "masculine")
        self.assertEqual(by_source["dog"].plural, "Hunde")
        self.assertEqual(by_source["dog"].part_of_speech, "noun")

    def test_verb_infinitive_recovered(self):
        cands = self._candidates([{
            "pos": "verb", "word": "laufen",
            "senses": [{"glosses": ["to run"]}],
        }])
        sources = {c.source: c for c in cands}
        self.assertIn("run", sources)
        self.assertEqual(sources["run"].part_of_speech, "verb")

    def test_noun_without_gender_or_plural_is_dropped(self):
        cands = self._candidates([{
            "pos": "noun", "word": "Ding",
            "senses": [{"glosses": ["thing"]}],  # no gender, no plural
        }])
        self.assertEqual(cands, [])

    def test_french_plural_is_derived_when_missing(self):
        cands = self._candidates([{
            "pos": "noun", "word": "cheval",
            "senses": [{"glosses": ["horse"], "tags": ["masculine"]}],
        }], language="fr")
        horse = next(c for c in cands if c.source == "horse")
        self.assertEqual(horse.plural, "chevaux")

    def test_form_of_senses_skipped(self):
        cands = self._candidates([{
            "pos": "noun", "word": "Hunde",
            "forms": [{"form": "Hunde", "tags": ["plural"]}],
            "senses": [{"glosses": ["dogs"], "tags": ["masculine", "form-of"]}],
        }])
        self.assertEqual(cands, [])


class ToEntryTest(unittest.TestCase):
    def test_noun_entry_has_gender_and_plural(self):
        cand = Candidate("dog", "noun", "Hund", "masculine", "Hunde", "dog", 5.0)
        entry = to_entry("dog", cand, 1, "wiktextract-de")
        self.assertEqual(entry["gender"], "masculine")
        self.assertEqual(entry["plural"], "Hunde")
        self.assertEqual(entry["partOfSpeech"], "noun")
        self.assertTrue(entry["eligible"])

    def test_non_noun_entry_omits_gender_and_plural(self):
        cand = Candidate("run", "verb", "laufen", None, None, "to run", 5.0)
        entry = to_entry("run", cand, 2, "wiktextract-de")
        self.assertNotIn("gender", entry)
        self.assertNotIn("plural", entry)


if __name__ == "__main__":
    unittest.main()
