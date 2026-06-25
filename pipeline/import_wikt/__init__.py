"""Build Contexto language packs from kaikki.org Wiktextract extracts.

The target-language extract (German/French/Italian) is INVERTED: each target word
carries English glosses + authoritative gender + plural, so mapping gloss→word
yields en→target entries with correct grammar — the schema Contexto needs.
"""
