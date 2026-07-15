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
                 wikidata=None, wikt_noun=None, wikt_gloss=None, wikt_match_gloss=None,
                 langlinks=None, wiktinv=None, slim_pos=None):
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
        "langlinks": langlinks or {},
        "wiktinv": wiktinv or {},
        "slim_pos": slim_pos or {},
    }


def wiktinv_prop(target, pos="noun", gloss="gloss"):
    """A single wiktinv proposal (as load_wiktinv_index would emit for a key)."""
    return {"target": target, "pos": pos, "gloss": gloss}


def wiki_entry(target, exists=True):
    """A pre-resolved langlinks proposal (as load_langlinks_index would emit)."""
    return {"target": target, "exists": exists}


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

    def test_negative_fully_parenthesized_token(self):
        # A bracketed segment is definitional and must never reduce to a lemma,
        # even a fully-parenthesized single token (trailing-punct stripping used
        # to peel "(dog)" -> "dog").
        self.assertFalse(bmq.gloss_matches_word_strict("(dog)", "dog"))
        self.assertFalse(bmq.gloss_matches_word_strict("[dog]", "dog"))
        self.assertFalse(bmq.gloss_matches_word_strict("dog (mammal)", "dog"))
        # ...but a clean segment alongside a bracketed one still matches.
        self.assertTrue(bmq.gloss_matches_word_strict("dog; (canine mammal)", "dog"))

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
    def test_entr_plus_wiktgloss_collapses_to_one_gate_vote(self):
        # entr and wiktgloss both derive from the English Wiktionary, so together
        # they are ONE independent vote and must NOT clear the >=2 gate alone.
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            wikt_match_gloss={"erdferkel": ["aardvark"]},
        )
        alts, _, passes2, diag2 = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertFalse(passes2)                    # collapses to 1 gate vote
        self.assertEqual(diag2["trueBest"], 1)       # 1 real dictionary vote
        self.assertEqual(diag2["strictBest"], 2)     # display still shows both
        self.assertEqual(diag2["gateBest"], 1)       # ...but the gate counts one
        self.assertIn("wiktgloss", alts[0]["sources"])  # provenance kept
        self.assertEqual(alts[0]["votes"], 2)
        # At min-votes 1 it still passes -- the collapse never changes tail volume.
        _, _, passes1, _ = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=1)
        self.assertTrue(passes1)

    def test_independent_dictionary_plus_wiktgloss_passes_at_two(self):
        # apertium is a genuinely different dictionary from the English
        # Wiktionary, so apertium+wiktgloss is TWO independent votes -> passes.
        idx = make_indexes(
            apertium={"aardvark": ["Erdferkel"]},
            wikt_match_gloss={"erdferkel": ["aardvark"]},
        )
        _, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertTrue(passes)
        self.assertEqual(diag["strictBest"], 2)
        self.assertEqual(diag["gateBest"], 2)

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


class RomanNumeralTest(unittest.TestCase):
    def test_positive(self):
        for w in ("i", "iv", "ix", "xvi", "mmxxiv", "di", "liv", "mi"):
            self.assertTrue(bmq.is_roman_numeral(w), w)

    def test_negative(self):
        # Real words and the empty string are not roman numerals.
        for w in ("", "aardvark", "the", "dog", "photosynthesis"):
            self.assertFalse(bmq.is_roman_numeral(w), w)


class LanglinksCasingTest(unittest.TestCase):
    """resolve_langlinks_casing: undo MediaWiki's forced first-letter capital by
    re-deriving casing from the target-side authorities (exact set + norm map)."""

    @staticmethod
    def _authority(*lemmas):
        exact = set(lemmas)
        norm_to_exact = {}
        for lemma in sorted(exact):
            norm_to_exact.setdefault(bmq.norm(lemma), lemma)
        return exact, norm_to_exact

    def test_de_noun_keeps_authority_capitalization(self):
        # German nouns are capitalized; the authority records "Mikroprozessor",
        # and the Wikipedia title already matches it exactly.
        exact, n2e = self._authority("Mikroprozessor")
        self.assertEqual(
            bmq.resolve_langlinks_casing("Mikroprozessor", "de", exact, n2e),
            ("Mikroprozessor", True))

    def test_es_common_noun_lowercased_via_authority(self):
        # Wikipedia capitalizes the title "Fotosíntesis"; the Spanish authority
        # has the common noun "fotosíntesis" -> adopt the lowercase form.
        exact, n2e = self._authority("fotosíntesis")
        self.assertEqual(
            bmq.resolve_langlinks_casing("Fotosíntesis", "es", exact, n2e),
            ("fotosíntesis", True))

    def test_absent_from_authority_de_keeps_wikipedia_casing_and_is_absent(self):
        exact, n2e = self._authority("etwasanderes")
        self.assertEqual(
            bmq.resolve_langlinks_casing("Neuwort", "de", exact, n2e),
            ("Neuwort", False))

    def test_absent_from_authority_es_strips_capital_and_is_absent(self):
        # es/fr/it: never emit a capitalized common noun on Wikipedia's say-so.
        exact, n2e = self._authority("otracosa")
        self.assertEqual(
            bmq.resolve_langlinks_casing("Palabranueva", "es", exact, n2e),
            ("palabranueva", False))

    def test_exists_in_other_casing_adopts_authority_form(self):
        # The authority stores an unusual casing the two checked forms miss;
        # existence still holds and the stored exact form is adopted.
        exact, n2e = self._authority("iPod")
        self.assertEqual(
            bmq.resolve_langlinks_casing("IPod", "it", exact, n2e),
            ("iPod", True))


class LanglinksIndexGateTest(unittest.TestCase):
    """The proper-noun hygiene gates live in load_langlinks_index; exercise them
    through a tiny on-disk TSV + authority so the gate arithmetic is real."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langlinks-gate-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _run(self, lang, rows, authority=()):
        path = self.tmp / f"langlinks-{lang}.tsv"
        path.write_text("".join(f"{w}\t{t}\n" for w, t in rows), encoding="utf-8")
        exact = set(authority)
        n2e = {}
        for lemma in sorted(exact):
            n2e.setdefault(bmq.norm(lemma), lemma)
        orig = bmq.WIKIPEDIA_DIR
        bmq.WIKIPEDIA_DIR = self.tmp
        try:
            return bmq.load_langlinks_index(lang, exact, n2e)
        finally:
            bmq.WIKIPEDIA_DIR = orig

    def test_acronym_target_skipped(self):
        idx, stats = self._run("es", [("laser", "LASER")])
        self.assertNotIn("laser", idx)
        self.assertEqual(stats["skip_t_acronym"], 1)

    def test_single_letter_and_roman_numeral_w_skipped(self):
        idx, stats = self._run("de", [("x", "X"), ("iv", "Vier"), ("cat", "Katze")])
        self.assertNotIn("x", idx)
        self.assertNotIn("iv", idx)
        self.assertIn("cat", idx)
        self.assertEqual(stats["skip_w_single_or_roman"], 2)

    def test_cognate_counted_but_kept(self):
        idx, stats = self._run("es", [("hotel", "Hotel")], authority=["hotel"])
        self.assertEqual(idx["hotel"], {"target": "hotel", "exists": True})
        self.assertEqual(stats["cognate_kept"], 1)


class LanglinksTierTest(unittest.TestCase):
    """Evidence-tier assignment for a wikipedia-proposed target."""

    def test_t1_when_a_real_dictionary_covotes_same_target(self):
        idx = make_indexes(
            apertium={"microprocessor": ["Mikroprozessor"]},
            langlinks={"microprocessor": wiki_entry("Mikroprozessor", exists=True)},
        )
        _, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "microprocessor", idx, min_votes=1)
        self.assertTrue(passes)
        self.assertEqual(diag["evidenceTier"], "T1")
        self.assertFalse(diag["wikipediaOnly"])  # apertium also proposed it

    def test_t1_wikipedia_plus_wiktgloss_is_independent(self):
        # wikipedia (a different wiki) + wiktgloss clears the >=2 gate and is T1.
        idx = make_indexes(
            langlinks={"aardvark": wiki_entry("Erdferkel", exists=True)},
            wikt_match_gloss={"erdferkel": ["aardvark"]},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertTrue(passes)
        self.assertEqual(diag["gateBest"], 2)
        self.assertEqual(diag["evidenceTier"], "T1")
        self.assertTrue(diag["wikipediaOnly"])
        self.assertEqual(alts[0]["sources"], ["wikipedia", "wiktgloss"])

    def test_t2_when_only_wikipedia_but_target_exists(self):
        idx = make_indexes(
            langlinks={"widget": wiki_entry("Dingsbums", exists=True)},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "widget", idx, min_votes=1)
        self.assertTrue(passes)
        self.assertEqual(diag["evidenceTier"], "T2")
        self.assertTrue(diag["wikipediaOnly"])
        self.assertEqual(alts[0]["sources"], ["wikipedia"])
        # wikipedia-only does NOT clear the >=2 gate.
        _, _, passes2, _ = bmq.build_alternatives_and_check_gate(
            "de", "widget", idx, min_votes=2)
        self.assertFalse(passes2)

    def test_t3_when_no_authority_knows_the_target(self):
        idx = make_indexes(
            langlinks={"widget": wiki_entry("Dingsbums", exists=False)},
        )
        _, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "widget", idx, min_votes=1)
        self.assertTrue(passes)
        self.assertEqual(diag["evidenceTier"], "T3")
        self.assertTrue(diag["wikipediaOnly"])

    def test_no_tier_when_wikipedia_did_not_propose(self):
        idx = make_indexes(apertium={"cat": ["Katze"]})
        _, _, _, diag = bmq.build_alternatives_and_check_gate(
            "de", "cat", idx, min_votes=1)
        self.assertIsNone(diag["evidenceTier"])
        self.assertFalse(diag["wikipediaOnly"])


class GlossStrictKeysParityTest(unittest.TestCase):
    """gloss_strict_keys is the INVERSION of gloss_matches_word_strict, not a second
    matcher: for every gloss/word pair, w in gloss_strict_keys(g) must agree exactly
    with gloss_matches_word_strict(g, w)."""

    GLOSSES = [
        "dog", "the house", "a dog", "dog; hound", "big, large", "related to war",
        "a kind of dog", "foot (a part of the body)", "free, without charge",
        "in vain, without success", "(dog)", "[dog]", "dog (mammal)",
        "dog; (canine mammal)", "", "   ", "hound, a canine", "An Owl", "dog.",
    ]
    WORDS = ["dog", "house", "the house", "hound", "large", "war", "foot", "free",
             "without charge", "in vain", "canine", "mammal", "owl", "doghouse"]

    def test_parity(self):
        for g in self.GLOSSES:
            keys = bmq.gloss_strict_keys(g)
            for w in self.WORDS:
                expected = bmq.gloss_matches_word_strict(g, w)
                got = w.strip().lower() in keys
                self.assertEqual(expected, got, f"gloss={g!r} word={w!r}")


class LoadWiktinvIndexTest(unittest.TestCase):
    """Exercise the real streaming inversion against a tiny on-disk slim cache."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wiktinv-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _run(self, lang, records):
        path = self.tmp / f"slim-{lang}.jsonl"
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
                        encoding="utf-8")
        orig = bmq.WIKT_CACHE_DIR
        bmq.WIKT_CACHE_DIR = self.tmp
        try:
            return bmq.load_wiktinv_index(lang)
        finally:
            bmq.WIKT_CACHE_DIR = orig

    def test_inverts_gloss_to_headword_with_pos(self):
        idx, slim_pos = self._run("de", [
            {"lemma": "Erdferkel", "pos": "noun", "gender": "neuter",
             "plural": "Erdferkel", "glosses": ["an aardvark", "the aardvark"]},
            {"lemma": "Hund", "pos": "noun", "gender": "masculine",
             "plural": "Hunde", "glosses": ["dog; hound"]},
        ])
        self.assertEqual([p["target"] for p in idx["aardvark"]], ["Erdferkel"])
        self.assertEqual(idx["aardvark"][0]["pos"], "noun")
        # comma/semicolon segments each become a key.
        self.assertEqual({p["target"] for p in idx["dog"]}, {"Hund"})
        self.assertEqual({p["target"] for p in idx["hound"]}, {"Hund"})
        self.assertEqual(slim_pos["hund"], {"noun"})

    def test_homograph_multiple_headwords_both_proposed(self):
        # Two distinct German nouns both gloss to "bank" -> both proposed.
        idx, _ = self._run("de", [
            {"lemma": "Bank", "pos": "noun", "gender": "feminine", "plural": "Bänke",
             "glosses": ["bench"]},
            {"lemma": "Ufer", "pos": "noun", "gender": "neuter", "plural": "Ufer",
             "glosses": ["bank; shore"]},
            {"lemma": "Geldinstitut", "pos": "noun", "gender": "neuter",
             "plural": "Geldinstitute", "glosses": ["bank"]},
        ])
        self.assertEqual({p["target"] for p in idx["bank"]}, {"Ufer", "Geldinstitut"})

    def test_multiword_target_pos_is_expression(self):
        idx, slim_pos = self._run("de", [
            {"lemma": "auf Wiedersehen", "pos": "adv", "gender": None, "plural": None,
             "glosses": ["goodbye"]},
        ])
        self.assertEqual(idx["goodbye"][0]["pos"], "expression")
        self.assertEqual(slim_pos["auf wiedersehen"], {"expression"})

    def test_missing_slim_file_yields_empty(self):
        idx, slim_pos = bmq.load_wiktinv_index("de")  # WIKT_CACHE_DIR unpatched -> real dir may lack it
        # es/de/fr/it are in HAS_WIKT_TARGET_DUMP; a missing file must not raise.
        self.assertIsInstance(idx, dict)


class WiktinvProposerTest(unittest.TestCase):
    def test_proposes_target_from_inversion_alone(self):
        idx = make_indexes(
            wiktinv={"aardvark": [wiktinv_prop("Erdferkel", pos="noun", gloss="an aardvark")]},
            wikt_noun={"erdferkel": [("neuter", "Erdferkel")]},
        )
        alts, _, passes1, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=1)
        self.assertTrue(passes1)
        self.assertEqual([a["target"] for a in alts], ["Erdferkel"])
        self.assertIn("wiktinv", alts[0]["sources"])
        self.assertEqual(alts[0]["pos"], "noun")
        self.assertEqual(alts[0]["wiktinvGloss"], "an aardvark")
        # morph comes free from the slim noun record.
        self.assertEqual(alts[0]["morph"],
                         {"gender": "neuter", "plural": "Erdferkel", "authority": "wiktextract"})
        self.assertTrue(diag["wiktinvOnly"])
        # wiktinv alone is ONE English-Wiktionary vote -> does NOT clear >=2.
        _, _, passes2, diag2 = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertFalse(passes2)
        self.assertEqual(diag2["gateBest"], 1)

    def test_homograph_multi_propose_not_merged(self):
        idx = make_indexes(
            wiktinv={"bank": [wiktinv_prop("Ufer", gloss="bank; shore"),
                              wiktinv_prop("Geldinstitut", gloss="bank")]},
        )
        alts, _, _, _ = bmq.build_alternatives_and_check_gate("de", "bank", idx, min_votes=1)
        self.assertEqual({a["target"] for a in alts}, {"Ufer", "Geldinstitut"})

    def test_wiktinv_does_not_also_get_a_wiktgloss_vote(self):
        # wiktinv and wiktgloss read the SAME slim gloss; the alt must not be
        # double-counted. wiktgloss is suppressed on a slim-derived alternative.
        idx = make_indexes(
            wiktinv={"aardvark": [wiktinv_prop("Erdferkel", gloss="aardvark")]},
            wikt_match_gloss={"erdferkel": ["aardvark"]},
        )
        alts, _, _, diag = bmq.build_alternatives_and_check_gate("de", "aardvark", idx, min_votes=1)
        self.assertIn("wiktinv", alts[0]["sources"])
        self.assertNotIn("wiktgloss", alts[0]["sources"])
        self.assertEqual(diag["gateBest"], 1)

    def test_independent_dictionary_plus_wiktinv_passes_at_two(self):
        # freedict (a genuinely independent dictionary) + wiktinv = TWO gate votes.
        idx = make_indexes(
            freedict={"aardvark": [("Erdferkel", "the aardvark", "noun")]},
            wiktinv={"aardvark": [wiktinv_prop("Erdferkel", gloss="aardvark")]},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertTrue(passes)
        self.assertEqual(diag["gateBest"], 2)
        self.assertFalse(diag["wiktinvOnly"])  # freedict co-proposed
        self.assertEqual(alts[0]["sources"], ["freedict", "wiktinv"])

    def test_entr_wiktinv_collapse_to_one_gate_vote(self):
        # entr proposes the same target wiktinv does; both are English Wiktionary,
        # so the pair collapses to ONE gate vote (fails >=2, passes >=1).
        idx = make_indexes(
            entr={"aardvark": entr_bucket("de", "Erdferkel")},
            wiktinv={"aardvark": [wiktinv_prop("Erdferkel", gloss="aardvark")]},
        )
        _, _, passes2, diag = bmq.build_alternatives_and_check_gate(
            "de", "aardvark", idx, min_votes=2)
        self.assertFalse(passes2)
        self.assertEqual(diag["gateBest"], 1)
        self.assertEqual(diag["strictBest"], 2)  # display still shows both


class GateVoteCountTest(unittest.TestCase):
    def test_family_collapses_to_one(self):
        self.assertEqual(bmq.gate_vote_count({"entr"}), 1)
        self.assertEqual(bmq.gate_vote_count({"entr", "wiktgloss"}), 1)
        self.assertEqual(bmq.gate_vote_count({"entr", "wiktgloss", "wiktinv"}), 1)

    def test_independent_source_plus_family(self):
        self.assertEqual(bmq.gate_vote_count({"freedict", "entr", "wiktgloss", "wiktinv"}), 2)
        self.assertEqual(bmq.gate_vote_count({"wikipedia", "wiktinv"}), 2)

    def test_all_independent_count_individually(self):
        self.assertEqual(bmq.gate_vote_count({"freedict", "apertium", "omw"}), 3)


class NormalizePosTest(unittest.TestCase):
    def test_maps_source_vocabularies(self):
        self.assertEqual(bmq.normalize_pos("n"), "noun")
        self.assertEqual(bmq.normalize_pos("pn"), "noun")
        self.assertEqual(bmq.normalize_pos("adjective"), "adjective")
        self.assertEqual(bmq.normalize_pos("adj"), "adjective")
        self.assertEqual(bmq.normalize_pos("adv"), "adverb")
        self.assertIsNone(bmq.normalize_pos("preposition"))
        self.assertIsNone(bmq.normalize_pos(None))

    def test_multiword_target_overrides_to_expression(self):
        self.assertEqual(bmq.normalize_pos("noun", "casa blanca"), "expression")
        self.assertEqual(bmq.normalize_pos("noun", "casa"), "noun")


class ClassifyAlternativeTest(unittest.TestCase):
    def test_noun_with_full_morph_is_mintable(self):
        k = bmq.classify_alternative({"gender": "masculine", "plural": "gatos"}, set(), "es")
        self.assertTrue(k["fullNounMorph"])
        self.assertTrue(k["mintable"])
        self.assertFalse(k["nounOnly"])
        self.assertEqual(k["posHint"], "noun")

    def test_noun_missing_plural_is_noun_only(self):
        k = bmq.classify_alternative({"gender": "masculine", "plural": None}, set(), "es")
        self.assertFalse(k["fullNounMorph"])
        self.assertFalse(k["mintable"])
        self.assertTrue(k["nounOnly"])

    def test_nonnoun_evidence_is_mintable_without_morph(self):
        k = bmq.classify_alternative(None, {"adjective"}, "es")
        self.assertTrue(k["mintable"])
        self.assertFalse(k["nounOnly"])
        self.assertEqual(k["posHint"], "adjective")

    def test_no_evidence_is_neither(self):
        k = bmq.classify_alternative(None, set(), "es")
        self.assertFalse(k["mintable"])
        self.assertFalse(k["nounOnly"])
        self.assertIsNone(k["posHint"])

    def test_gender_not_in_language_set_is_not_full(self):
        # neuter is not an es gender -> cannot mint as a noun.
        k = bmq.classify_alternative({"gender": "neuter", "plural": "x"}, set(), "es")
        self.assertFalse(k["fullNounMorph"])
        self.assertTrue(k["nounOnly"])


class PreSkipTest(unittest.TestCase):
    def test_noun_no_morph_any_when_every_alt_is_noun_without_morph(self):
        # A single wikipedia-proposed noun target with a gender but no plural, no
        # non-noun reading -> cannot clear apply_verdicts as a noun, no escape.
        idx = make_indexes(
            langlinks={"mitochondria": wiki_entry("Mitochondrium", exists=True)},
            wikt_noun={"mitochondrium": [("neuter", None)]},   # gender, NULL plural
            slim_pos={"mitochondrium": {"noun"}},
        )
        alts, _, passes, diag = bmq.build_alternatives_and_check_gate(
            "de", "mitochondria", idx, min_votes=1)
        self.assertTrue(passes)  # still in the queue (never dropped)
        self.assertEqual(diag["preSkip"], "noun_no_morph_any")
        self.assertFalse(diag["shippableAlt"])

    def test_full_morph_noun_is_shippable_not_preskipped(self):
        idx = make_indexes(
            langlinks={"mitochondria": wiki_entry("Mitochondrium", exists=True)},
            wikt_noun={"mitochondrium": [("neuter", "Mitochondrien")]},
            slim_pos={"mitochondrium": {"noun"}},
        )
        _, _, _, diag = bmq.build_alternatives_and_check_gate(
            "de", "mitochondria", idx, min_votes=1)
        self.assertIsNone(diag["preSkip"])
        self.assertTrue(diag["shippableAlt"])

    def test_cognate_nonnoun_when_best_alt_is_identical_and_nonnoun(self):
        # es "total" (adjective) == English "total": identical + non-noun -> the
        # runtime would never inject it. freedict tags it adjective (non-noun ev).
        idx = make_indexes(
            freedict={"total": [("total", "whole", "adjective")]},
            apertium={"total": ["total"]},
            slim_pos={"total": {"adjective"}},
        )
        alts, _, _, diag = bmq.build_alternatives_and_check_gate("es", "total", idx, min_votes=1)
        self.assertEqual(alts[0]["target"], "total")
        self.assertEqual(diag["preSkip"], "cognate_nonnoun")

    def test_nonnoun_alternative_escapes_noun_no_morph(self):
        # One alt is a noun without morph, another is a verb (mintable non-noun) ->
        # NOT preSkipped, and shippable.
        idx = make_indexes(
            apertium={"run": ["Lauf", "laufen"]},
            wikt_noun={"lauf": [("masculine", None)]},  # noun, no plural
            slim_pos={"lauf": {"noun"}, "laufen": {"verb"}},
        )
        _, _, _, diag = bmq.build_alternatives_and_check_gate("de", "run", idx, min_votes=1)
        self.assertIsNone(diag["preSkip"])
        self.assertTrue(diag["shippableAlt"])


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
             # A genuinely-independent 2-vote pairing (apertium + wiktgloss) --
             # entr+wiktgloss no longer clears the gate, see WiktglossVoteTest.
             "alternatives": [{
                 "target": "Erdferkel", "votes": 2, "sources": ["apertium", "wiktgloss"],
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
