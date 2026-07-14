import unittest

from pipeline.import_es.regloss_legacy import (
    choose_aligned_gloss,
    first_clause,
    fold,
    usable_gloss,
)


def sense(g, targets, n):
    return {"g": g, "targets": {fold(t) for t in targets}, "n": n}


class UsableGlossTests(unittest.TestCase):
    def test_rejects_meta_one_word_and_dangling_glosses(self):
        self.assertFalse(usable_gloss(""))
        self.assertFalse(usable_gloss("Direction."))
        self.assertFalse(usable_gloss("Ellipsis of mobile data."))
        self.assertFalse(usable_gloss("Alternative spelling of colour."))
        self.assertFalse(usable_gloss("A rule, such as:"))
        self.assertFalse(usable_gloss("Any protracted conflict, particularly"))

    def test_accepts_ordinary_definitions(self):
        self.assertTrue(usable_gloss("A specific form or variation of something."))


class FirstClauseTests(unittest.TestCase):
    def test_short_glosses_pass_through(self):
        self.assertEqual(first_clause("A short gloss."), "A short gloss.")

    def test_long_glosses_cut_at_a_sentence_boundary(self):
        long = ("A string of characters used to log in to a computer or network, "
                "to access a level in a video game, and so on; archetypally a word "
                "but nowadays often an alphanumeric string.")
        cut = first_clause(long)
        self.assertTrue(cut.endswith("and so on"))


class ChooseAlignedGlossTests(unittest.TestCase):
    def test_prefers_dominant_aligned_sense(self):
        # version: the "specific form" sense has the larger table.
        senses = [
            sense("A specific form or variation of something.", ["versión"], 6),
            sense("A translation from one language to another.", ["versión"], 3),
        ]
        self.assertEqual(choose_aligned_gloss(senses, fold("versión")),
                         "A specific form or variation of something.")

    def test_unaligned_targets_get_nothing(self):
        senses = [sense("An enclosed space; a courtyard.", ["patio"], 8)]
        self.assertIsNone(choose_aligned_gloss(senses, fold("tribunal")))

    def test_niche_glossed_sense_defers_to_glossless_dominant_table(self):
        # death: the main translations live in a gloss-less word-level block
        # (n=18); the only GLOSSED aligned sense is the Grim Reaper (n=4).
        senses = [
            sense("The personification of death; the Grim Reaper.", ["Muerte"], 4),
            sense("", ["muerte", "la muerte"], 18),
        ]
        self.assertIsNone(choose_aligned_gloss(senses, fold("muerte")))


if __name__ == "__main__":
    unittest.main()
