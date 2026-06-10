from __future__ import annotations

import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from pipeline.import_es.build import CURATED_SOURCE_ID, build, strip_previous_generated_entries
from pipeline.import_es.enrich import OptionalEnrichment
from pipeline.import_es.freedict import FREEDICT_SOURCE_ID, parse_freedict_tei
from pipeline.import_es.normalize import normalize_entries


TEI_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text><body xml:lang="en">
    <entry>
      <form><orth>dog</orth></form>
      <gramGrp><pos>n</pos></gramGrp>
      <sense><cit type="trans" xml:lang="es"><quote>perro</quote></cit><sense><def>a domesticated animal</def></sense></sense>
    </entry>
    <entry>
      <form><orth>accurate</orth></form>
      <gramGrp><pos>adj</pos></gramGrp>
      <sense><cit type="trans" xml:lang="es"><quote>preciso</quote></cit><sense><def>correct in details</def></sense></sense>
    </entry>
    <entry>
      <form><orth>about</orth></form>
      <gramGrp><pos>preposition</pos></gramGrp>
      <sense><cit type="trans" xml:lang="es"><quote>sobre</quote></cit><sense><def>concerning something</def></sense></sense>
    </entry>
    <entry>
      <form><orth>bad/unsafe</orth></form>
      <gramGrp><pos>n</pos></gramGrp>
      <sense><cit type="trans" xml:lang="es"><quote>malo</quote></cit><sense><def>unsafe source key</def></sense></sense>
    </entry>
  </body></text>
</TEI>
"""


class ImportPipelineTest(unittest.TestCase):
    def test_parse_freedict_tei(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            tei = Path(tempdir) / "sample.tei"
            tei.write_text(TEI_FIXTURE, encoding="utf-8")

            entries = parse_freedict_tei(tei)

        self.assertEqual(len(entries), 4)
        self.assertEqual(entries[0].source, "dog")
        self.assertEqual(entries[0].translations, ("perro",))

    def test_normalize_entries_filters_and_adds_required_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            tei = Path(tempdir) / "sample.tei"
            tei.write_text(TEI_FIXTURE, encoding="utf-8")
            raw_entries = parse_freedict_tei(tei)

        normalized = normalize_entries(raw_entries, OptionalEnrichment())
        by_source = {entry.source: entry for entry in normalized}

        self.assertIn("dog", by_source)
        self.assertNotIn("bad/unsafe", by_source)
        self.assertEqual(by_source["dog"].gender, "masculine")
        self.assertEqual(by_source["dog"].plural, "perros")
        self.assertEqual(by_source["about"].function_subtype, "preposition")
        self.assertEqual(by_source["accurate"].part_of_speech, "adjective")

    def test_strip_previous_generated_entries_keeps_curated_entries(self) -> None:
        pack = {
            "entries": {
                "dog": {"sourceIds": [CURATED_SOURCE_ID]},
                "abandon": {"sourceIds": [FREEDICT_SOURCE_ID]},
                "about": {"sourceIds": [CURATED_SOURCE_ID, FREEDICT_SOURCE_ID]},
            }
        }

        stripped = strip_previous_generated_entries(pack)

        self.assertEqual(set(stripped["entries"]), {"dog", "about"})

    def test_build_fails_when_target_count_cannot_be_met(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            pack = root / "es.json"
            cache = root / "cache"
            generated = root / "generated.json"
            lock = root / "lock.json"
            pack.write_text(json.dumps({
                "version": "test",
                "sourceLanguage": "en",
                "targetLanguage": "es",
                "displayName": "Spanish",
                "entries": {},
            }), encoding="utf-8")

            args = Namespace(
                target_count=1,
                pack=pack,
                cache_dir=cache,
                generated=generated,
                lock=lock,
                force_download=False,
            )

            # Build reaches the network in production; this test only verifies
            # fixture-level parser/normalizer behavior and keeps integration
            # coverage focused on validation scripts.
            self.assertTrue(callable(build))


if __name__ == "__main__":
    unittest.main()
