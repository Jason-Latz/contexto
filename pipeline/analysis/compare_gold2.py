#!/usr/bin/env python3
"""Score the engine's gold2 verdicts against the hand-built gold2 answer key.

This is the gold2 analogue of compare_gold.py, with three deliberate changes:

  1. JOIN BY KEY, not positionally. gold2 keys are globally unique across all
     570 rows and across languages (verified at load time: every effective key
     appears in the answer key and vice-versa), so an unambiguous by-key join is
     both possible and safer than positional alignment.
  2. The headline gate metric is the SHIP-STRATUM false-change rate, not the raw
     false-change rate: only changes that would actually be written by
     apply_verdicts.py --ship-stratum strict (refuter=="agree" OR judge-ruled,
     AND confidence>=0.8) can corrupt the shipped pack, so those are the changes
     that matter. falseKeepRate is reported but informational only.
  3. Because the gold labels themselves carry ~2-3% noise (the v1 gold-gate
     postmortem found ~10 gold-label-suspect rows), every ship-stratum
     false-change DISAGREEMENT is re-examined by hand from the full queue-record
     evidence and classified engine-wrong vs gold-suspect. adjShipFalseChange
     divides only the engine-wrong ones by nShipChanges. The classification is a
     fixed, audited table (SHIP_FALSECHANGE_REVIEW below) -- it is asserted
     against the computed disagreement set at runtime so the two can't drift.

Inputs:
  pipeline/data/verdicts/final/gold2-mixed-{0..12}.jsonl - engine adjudication
      output. verdict in {"keep", "retarget", "gate"}; carries confidence and a
      refuter ("agree"/"dispute"/"unreviewed").
  pipeline/data/verdicts/fixup/gold2-mixed-{0..12}.jsonl - opus-judge overrides
      for disputed rows (adds "judge", drops "refuter"). A fixup row REPLACES the
      final row for the same key before comparison -- mirrors
      apply_verdicts.effective_rows() ("fixup wins").
  pipeline/data/queues/gold2-answers.jsonl - the answer key:
      {lang, key, verdict, correctedTarget, ..., rationale}.
  pipeline/data/queues/gold2-mixed.jsonl   - the queue rows fed to the engine;
      the full per-key evidence (entrSenses, currentTargetGlosses, omw,
      alternatives, morph) used to hand-adjudicate the disagreements.

Ship stratum (mirrors apply_verdicts.ship_stratum_ok, kept in lockstep):
  a change (verdict != "keep") ships iff confidence>=0.8 AND
  (refuter=="agree" OR the row is judge-ruled, i.e. carries "judge").

Metrics, per language:
  n                        - joined rows for the language.
  agreement                - exact verdict-match rate.
  falseKeepRate            - INFORMATIONAL. Among gold retarget/gate rows, the
                             fraction the engine called keep.
  shipStratumFalseChangeRate - among ship-stratum changes, the fraction gold
                             says keep. (+ nShipChanges as the denominator.)
  adjShipFalseChange       - engine-wrong ship-stratum changes / nShipChanges,
                             after hand-review reclassifies gold-label-suspect
                             disagreements as NOT engine errors.

Output:
  pipeline/data/evidence/gold2-gate.json - metrics + confusion matrices + every
      ship-stratum false-change disagreement quoted with its full queue evidence
      and its engine-wrong/gold-suspect classification.
  pipeline/data/evidence/gold2-gate.md   - human-readable render of the same.

Usage:
    python3 pipeline/analysis/compare_gold2.py
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
QUEUES_DIR = REPO_ROOT / "pipeline" / "data" / "queues"
FINAL_DIR = REPO_ROOT / "pipeline" / "data" / "verdicts" / "final"
FIXUP_DIR = REPO_ROOT / "pipeline" / "data" / "verdicts" / "fixup"
EVIDENCE_DIR = REPO_ROOT / "pipeline" / "data" / "evidence"

SHARD_COUNT = 13
VERDICTS = ("keep", "retarget", "gate")
SHIP_CONFIDENCE_MIN = 0.8

# ---------------------------------------------------------------------------
# Hand-review of every ship-stratum false-change disagreement.
#
# Each entry answers: is the ENGINE wrong (it changed a genuinely fine entry) or
# is the GOLD label suspect (the engine's change is actually right -- the current
# target really does mismatch the entry gloss)? Reviewed from the full queue
# record; "engine-wrong" is the default when genuinely unclear (do not rescue the
# engine). classification in {"engine-wrong", "gold-suspect"}.
#
# Keyed by (lang, key). This table is asserted to exactly equal the computed set
# of ship-stratum false-change disagreements, so it cannot silently drift.
# ---------------------------------------------------------------------------
SHIP_FALSECHANGE_REVIEW: dict[tuple[str, str], dict] = {
    ("de", "candid"): {
        "classification": "engine-wrong",
        "note": "direkt renders candid's DOMINANT sense (frank/forthright of a person), "
                "which gold accepts as overlapping. The entry gloss happens to catalogue only "
                "the narrower 'impartial/unprejudiced' sense; retargeting to unvoreingenommen "
                "swaps the common sense for the rarer one. Engine changed a defensible entry.",
    },
    ("de", "emaciate"): {
        "classification": "engine-wrong",
        "note": "entrSenses.containsCurrent is TRUE -- entr itself attests abmagern for the "
                "gloss 'to make extremely thin or wasted'. abmagern is in the right field "
                "(become emaciated/thin); ausmergeln is at most an improvement, not a fix.",
    },
    ("de", "miscast"): {
        "classification": "engine-wrong",
        "note": "The entry is pos=noun and Fehlbesetzung (die Fehlbesetzung, pl Fehlbesetzungen) "
                "is precisely 'miscasting', the dominant real sense of miscast. The catalogued "
                "gloss is an archaic verb sense; the opus fixup retargeted a correct noun to a "
                "verb to chase it. Gold is right.",
    },
    ("de", "siliceous"): {
        "classification": "engine-wrong",
        "note": "silicatisch and kieselhaltig are near-synonyms in the same silica/silicate "
                "technical domain; gold calls silicatisch a correct-but-improvable technical "
                "synonym. Not a wrong-sense error.",
    },
    ("de", "tempo"): {
        "classification": "engine-wrong",
        "note": "Geschwindigkeit = speed/pace is a correct translation of tempo (its own glosses "
                "list 'tempo, pace, rate'); die Geschwindigkeit morph is correct. Tempo is a "
                "marginally better loanword match, but the current entry is not wrong.",
    },
    ("de", "togolese"): {
        "classification": "engine-wrong",
        "note": "Togoer (der Togoer, pl Togoer) is a correct demonym with full morph authority; "
                "the engine gated it on a blanket demonym POLICY, not on any sense error. Gold "
                "correctly keeps a genuinely fine entry.",
    },
    ("es", "cybernaut"): {
        "classification": "gold-suspect",
        "note": "GOLD SELF-CONTRADICTS: its keep rationale says 'tagging it feminine-only is "
                "wrong' (cibernauta is a comun-gender -nauta noun, el cibernauta). The engine's "
                "flag-gender retarget corrects feminine->masculine (wikidata), moving toward the "
                "citation form. The engine's change is right; the keep label is the suspect one.",
    },
    ("es", "helping hand"): {
        "classification": "engine-wrong",
        "note": "'mano auxiliar' is a comprehensible literal calque for a helping hand; gold "
                "judges it conveys assistance and notes no alternative exists to retarget to. "
                "The gate removes an entry gold considers fine; genuinely borderline -> "
                "engine-wrong by default.",
    },
    ("es", "shitling"): {
        "classification": "engine-wrong",
        "note": "The engine gated on a vulgar-only POLICY, not on incorrectness; gold judges "
                "merdita a transparent, teachable vulgar diminutive. Policy overreach removed an "
                "entry gold labels keep-worthy -> counts as an engine false change, not gold noise.",
    },
    ("es", "tepanec"): {
        "classification": "engine-wrong",
        "note": "tepaneca is the correct Spanish demonym form; gated on demonym POLICY alone. "
                "Genuinely fine entry removed.",
    },
    ("es", "triplet"): {
        "classification": "engine-wrong",
        "note": "terceto genuinely means 'a set/group of three' (also musical triplet / poetic "
                "tercet) and fits the gloss 'a set of three'; omw lists it under the '3' sense. "
                "trio is an alternative, not a correction. Gold is right.",
    },
    ("fr", "cour d'honneur"): {
        "classification": "engine-wrong",
        "note": "cour d'honneur is a correct French loanword; the target matches the gloss and "
                "is not a wrong sense. The engine removed it on a teaches-nothing (identical to "
                "source) utility rule, not a sense error -- gold correctly keeps a right entry.",
    },
    ("fr", "decryption"): {
        "classification": "engine-wrong",
        "note": "decryptement is a valid (if less common than decryptage) French noun for "
                "decryption, masculine; gold accepts it. Retarget to the more common synonym is "
                "an improvement, not a fix.",
    },
    ("fr", "fiscal"): {
        "classification": "engine-wrong",
        "note": "fiscal is a correct French adjective matching the treasury/tax gloss; gated only "
                "for being spelled identically to the English source (teaches-nothing utility "
                "rule), not for any sense mismatch. Correct entry removed.",
    },
    ("fr", "frontage"): {
        "classification": "engine-wrong",
        "note": "devanture = shop frontage/storefront is a correct, feminine rendering of "
                "frontage; gold accepts it. facade is a broader alternative, not a correction of "
                "a wrong sense.",
    },
    ("fr", "noun adjective"): {
        "classification": "engine-wrong",
        "note": "'nom adjectif' is a real (dated) French grammatical term matching 'noun "
                "adjective'; the engine dismissed it as multiword junk on empty gloss evidence. "
                "Gold's linguistic identification stands -> engine wrongly gated a fine entry.",
    },
    ("fr", "swabian"): {
        "classification": "engine-wrong",
        "note": "souabe = Swabian is correct (containsCurrent true) and was gated purely on "
                "demonym/toponym POLICY. Genuinely fine entry removed.",
    },
    ("it", "abortive"): {
        "classification": "engine-wrong",
        "note": "mancato (missed/failed) renders the DOMINANT modern sense of abortive "
                "('unsuccessful', e.g. abortive attempt/coup). The opus fixup retargeted to "
                "abortivo, the rarer biological sense catalogued in the gloss -- swapping the "
                "common sense for the rare one. Gold is right.",
    },
    ("it", "barbadian"): {
        "classification": "engine-wrong",
        "note": "barbadiano is a correct demonym (containsCurrent true), gated on demonym POLICY "
                "alone. Genuinely fine entry removed.",
    },
    ("it", "haunting"): {
        "classification": "engine-wrong",
        "note": "ossessivo (obsessive/lingering) plausibly conveys the adjectival 'haunting' "
                "(struggente/ossessionante shares its root); gold judges it renders the dominant "
                "sense. The opus fixup gated on a wrong-sense argument that is not clear-cut -> "
                "engine-wrong by default.",
    },
    ("it", "lie flat"): {
        "classification": "engine-wrong",
        "note": "spianare (level/flatten/roll out) plausibly covers 'lay/lie flat' in the "
                "make-flat reading; the entry gloss is empty so the mismatch is unproven. Gold "
                "keeps it -> engine-wrong by default on genuinely unclear evidence.",
    },
    ("it", "trade fair"): {
        "classification": "engine-wrong",
        "note": "fiera is the ordinary Italian word for a trade fair/expo (Fiera di Milano) and "
                "renders the sense correctly; fiera campionaria is a more explicit variant, not a "
                "correction. Gold is right.",
    },
}


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def load_effective_rows() -> dict[str, dict]:
    """Every final row across the 13 shards, keyed by `key`, with matching fixup
    (judge) rulings substituted in -- "fixup wins", mirroring
    apply_verdicts.effective_rows(). Keys are globally unique across shards."""
    by_key: dict[str, dict] = {}
    for i in range(SHARD_COUNT):
        for row in load_jsonl(FINAL_DIR / f"gold2-mixed-{i}.jsonl"):
            if "key" in row:
                by_key[row["key"]] = row
    for i in range(SHARD_COUNT):
        for row in load_jsonl(FIXUP_DIR / f"gold2-mixed-{i}.jsonl"):
            if "key" in row:
                by_key[row["key"]] = row  # fixup wins
    return by_key


def ship_stratum_ok(row: dict) -> bool:
    """Mirror of apply_verdicts.ship_stratum_ok: a change ships only when
    confidence>=0.8 AND (refuter=='agree' OR judge-ruled)."""
    confidence = row.get("confidence")
    if not isinstance(confidence, (int, float)) or confidence < SHIP_CONFIDENCE_MIN:
        return False
    if row.get("refuter") == "agree":
        return True
    return bool(row.get("judge"))


def truncate(text, limit: int = 400) -> str:
    if not isinstance(text, str):
        return text
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_joined_rows() -> list[dict]:
    engine_by_key = load_effective_rows()
    answers = load_jsonl(QUEUES_DIR / "gold2-answers.jsonl")
    queue_by_key = {q["key"]: q for q in load_jsonl(QUEUES_DIR / "gold2-mixed.jsonl") if "key" in q}

    answer_keys = {a["key"] for a in answers}
    engine_keys = set(engine_by_key)
    only_engine = sorted(engine_keys - answer_keys)
    only_answer = sorted(answer_keys - engine_keys)
    if only_engine or only_answer:
        raise SystemExit(
            "by-key join is not total: "
            f"{len(only_engine)} engine-only keys {only_engine[:8]}, "
            f"{len(only_answer)} answer-only keys {only_answer[:8]}"
        )
    if len(answers) != len(answer_keys):
        raise SystemExit("gold2-answers.jsonl has duplicate keys; by-key join is unsafe")

    joined = []
    for answer in answers:
        key = answer["key"]
        engine = engine_by_key[key]
        queue = queue_by_key.get(key, {})
        engine_verdict = engine.get("verdict")
        joined.append({
            "lang": answer.get("lang"),
            "key": key,
            "engineVerdict": engine_verdict,
            "engineNewTarget": engine.get("newTarget"),
            "engineNewGender": engine.get("newGender"),
            "engineConfidence": engine.get("confidence"),
            "engineRefuter": engine.get("refuter"),
            "engineJudge": engine.get("judge"),
            "engineReason": engine.get("reason"),
            "shipsChange": engine_verdict != "keep" and ship_stratum_ok(engine),
            "goldVerdict": answer.get("verdict"),
            "goldCorrectedTarget": answer.get("correctedTarget"),
            "goldRationale": answer.get("rationale"),
            "currentTarget": queue.get("target"),
            "queue": queue,
        })
    return joined


def confusion_matrix(rows: list[dict]) -> dict:
    matrix = {g: {e: 0 for e in VERDICTS} for g in VERDICTS}
    other = Counter()
    for row in rows:
        g, e = row["goldVerdict"], row["engineVerdict"]
        if g in matrix and e in matrix[g]:
            matrix[g][e] += 1
        else:
            other[(g, e)] += 1
    result = {"goldRowsByEngineVerdict": matrix}
    if other:
        result["unmatchedPairs"] = {f"{g}->{e}": n for (g, e), n in other.items()}
    return result


def quote_disagreement(row: dict) -> dict:
    """Full queue-evidence quote for one ship-stratum false-change disagreement,
    with its hand-review classification attached."""
    q = row["queue"]
    review = SHIP_FALSECHANGE_REVIEW.get((row["lang"], row["key"]), {})
    return {
        "lang": row["lang"],
        "key": row["key"],
        "engineVerdict": row["engineVerdict"],
        "engineNewTarget": row["engineNewTarget"],
        "engineNewGender": row["engineNewGender"],
        "engineConfidence": row["engineConfidence"],
        "engineRefuter": row["engineRefuter"],
        "engineJudge": row["engineJudge"],
        "engineReason": truncate(row["engineReason"]),
        "goldVerdict": row["goldVerdict"],
        "goldRationale": truncate(row["goldRationale"]),
        "currentTarget": row["currentTarget"],
        "pos": q.get("pos"),
        "gender": q.get("gender"),
        "plural": q.get("plural"),
        "enZipf": q.get("enZipf"),
        "entrSenses": q.get("entrSenses"),
        "currentTargetGlosses": q.get("currentTargetGlosses"),
        "omw": q.get("omw"),
        "alternatives": [
            {
                "target": a.get("target"),
                "votes": a.get("votes"),
                "sources": a.get("sources"),
                "morph": a.get("morph"),
                "glosses": a.get("glosses"),
            }
            for a in (q.get("alternatives") or [])
        ],
        "classification": review.get("classification"),
        "reviewNote": review.get("note"),
    }


def metrics_for(rows: list[dict], disagreements: list[dict]) -> dict:
    n = len(rows)
    agree = sum(1 for r in rows if r["engineVerdict"] == r["goldVerdict"])

    gold_bad = [r for r in rows if r["goldVerdict"] in ("retarget", "gate")]
    false_keep = [r for r in gold_bad if r["engineVerdict"] == "keep"]

    ship_changes = [r for r in rows if r["shipsChange"]]
    ship_false_change = [r for r in ship_changes if r["goldVerdict"] == "keep"]
    n_ship = len(ship_changes)

    engine_wrong = [d for d in disagreements if d["classification"] == "engine-wrong"]
    gold_suspect = [d for d in disagreements if d["classification"] == "gold-suspect"]

    return {
        "n": n,
        "agreement": (agree / n) if n else None,
        "falseKeepRate": (len(false_keep) / len(gold_bad)) if gold_bad else None,
        "falseKeepCount": len(false_keep),
        "goldBadCount": len(gold_bad),
        "shipStratumFalseChangeRate": (len(ship_false_change) / n_ship) if n_ship else None,
        "shipStratumFalseChangeCount": len(ship_false_change),
        "nShipChanges": n_ship,
        "adjShipFalseChange": (len(engine_wrong) / n_ship) if n_ship else None,
        "engineWrongCount": len(engine_wrong),
        "goldSuspectCount": len(gold_suspect),
        "confusionMatrix": confusion_matrix(rows),
    }


def build_report(rows: list[dict]) -> dict:
    # Compute the ship-stratum false-change disagreement set, then reconcile it
    # against the hand-review table so neither can drift from the other.
    disagreement_rows = [r for r in rows if r["shipsChange"] and r["goldVerdict"] == "keep"]
    computed_keys = {(r["lang"], r["key"]) for r in disagreement_rows}
    table_keys = set(SHIP_FALSECHANGE_REVIEW)
    if computed_keys != table_keys:
        raise SystemExit(
            "SHIP_FALSECHANGE_REVIEW is out of sync with the computed disagreements.\n"
            f"  missing from table: {sorted(computed_keys - table_keys)}\n"
            f"  stale in table:     {sorted(table_keys - computed_keys)}"
        )
    disagreements = [quote_disagreement(r) for r in disagreement_rows]
    for d in disagreements:
        if d["classification"] not in ("engine-wrong", "gold-suspect"):
            raise SystemExit(f"unclassified disagreement: {(d['lang'], d['key'])}")

    by_lang_disagreements: dict[str, list[dict]] = {}
    for d in disagreements:
        by_lang_disagreements.setdefault(d["lang"], []).append(d)

    langs = sorted({r["lang"] for r in rows})
    per_language = {}
    for lang in langs:
        lang_rows = [r for r in rows if r["lang"] == lang]
        m = metrics_for(lang_rows, by_lang_disagreements.get(lang, []))
        m["disagreements"] = by_lang_disagreements.get(lang, [])
        per_language[lang] = m

    pooled = metrics_for(rows, disagreements)

    return {
        "source": "gold2-gate",
        "join": "by-key (globally unique keys; join verified total on both sides)",
        "shipStratumRule": "confidence>=0.8 AND (refuter=='agree' OR judge-ruled)",
        "n": len(rows),
        "languages": langs,
        "perLanguage": per_language,
        "pooled": pooled,
        "disagreements": disagreements,
    }


def _fmt_pct(value) -> str:
    return f"{value:.1%}" if isinstance(value, (int, float)) else "n/a"


def render_markdown(report: dict) -> str:
    out: list[str] = []
    out.append("# gold2-gate comparison")
    out.append("")
    out.append(
        f"Engine gold2 verdicts (`final/gold2-mixed-*.jsonl` + `fixup/` overrides, fixup wins) "
        f"vs. the answer key (`queues/gold2-answers.jsonl`), joined **by key**. n = {report['n']}."
    )
    out.append("")
    out.append(f"Ship stratum: **{report['shipStratumRule']}** "
               "(mirrors `apply_verdicts.ship_stratum_ok`).")
    out.append("")
    out.append("`falseKeepRate` is informational. The gate metric is "
               "`shipStratumFalseChangeRate`, and `adjShipFalseChange` is it after every "
               "ship-stratum false-change disagreement is hand-reviewed and gold-label-suspect "
               "rows are removed from the numerator.")
    out.append("")

    # Summary table.
    out.append("## Summary")
    out.append("")
    out.append("| lang | n | agreement | falseKeep | shipFalseChange | adjShipFalseChange | nShipChanges |")
    out.append("|---|---|---|---|---|---|---|")
    for lang in report["languages"]:
        m = report["perLanguage"][lang]
        out.append(
            f"| {lang} | {m['n']} | {_fmt_pct(m['agreement'])} | "
            f"{_fmt_pct(m['falseKeepRate'])} ({m['falseKeepCount']}/{m['goldBadCount']}) | "
            f"{_fmt_pct(m['shipStratumFalseChangeRate'])} ({m['shipStratumFalseChangeCount']}/{m['nShipChanges']}) | "
            f"{_fmt_pct(m['adjShipFalseChange'])} ({m['engineWrongCount']}/{m['nShipChanges']}) | "
            f"{m['nShipChanges']} |"
        )
    p = report["pooled"]
    out.append(
        f"| **pooled** | {p['n']} | {_fmt_pct(p['agreement'])} | "
        f"{_fmt_pct(p['falseKeepRate'])} ({p['falseKeepCount']}/{p['goldBadCount']}) | "
        f"{_fmt_pct(p['shipStratumFalseChangeRate'])} ({p['shipStratumFalseChangeCount']}/{p['nShipChanges']}) | "
        f"{_fmt_pct(p['adjShipFalseChange'])} ({p['engineWrongCount']}/{p['nShipChanges']}) | "
        f"{p['nShipChanges']} |"
    )
    out.append("")

    # Confusion matrices.
    def render_cm(name: str, m: dict) -> None:
        out.append(f"### {name} confusion matrix (rows = gold, cols = engine)")
        out.append("")
        cm = m["confusionMatrix"]["goldRowsByEngineVerdict"]
        out.append("| gold \\ engine | keep | retarget | gate |")
        out.append("|---|---|---|---|")
        for g in VERDICTS:
            out.append(f"| {g} | {cm[g]['keep']} | {cm[g]['retarget']} | {cm[g]['gate']} |")
        if m["confusionMatrix"].get("unmatchedPairs"):
            out.append("")
            out.append(f"Off-enum pairs: {m['confusionMatrix']['unmatchedPairs']}")
        out.append("")

    out.append("## Confusion matrices")
    out.append("")
    for lang in report["languages"]:
        render_cm(f"Language {lang}", report["perLanguage"][lang])
    render_cm("Pooled", report["pooled"])

    # Disagreement dossier.
    out.append("## Ship-stratum false-change disagreements (hand-reviewed)")
    out.append("")
    out.append(
        "Every change that clears the ship stratum yet gold labels `keep`. Each is "
        "re-adjudicated from the full queue evidence: **engine-wrong** = the engine changed a "
        "genuinely fine entry; **gold-suspect** = the engine's change is actually right and the "
        "gold `keep` label is the noisy one. Unclear cases are counted engine-wrong."
    )
    out.append("")
    for lang in report["languages"]:
        ds = report["perLanguage"][lang]["disagreements"]
        if not ds:
            continue
        out.append(f"### {lang}")
        out.append("")
        for d in ds:
            tag = "🔴 ENGINE-WRONG" if d["classification"] == "engine-wrong" else "🟡 GOLD-SUSPECT"
            out.append(f"#### `{d['key']}` — {tag}")
            out.append("")
            out.append(
                f"- engine: **{d['engineVerdict']}**"
                + (f" → `{d['engineNewTarget']}`" if d["engineNewTarget"] else "")
                + (f" ({d['engineNewGender']})" if d["engineNewGender"] else "")
                + f"  · conf {d['engineConfidence']}"
                + f" · refuter {d['engineRefuter']!r}"
                + (f" · judge {d['engineJudge']!r}" if d["engineJudge"] else "")
            )
            out.append(f"- current target: `{d['currentTarget']}`"
                       + (f" ({d['gender']}, pl {d['plural']})" if d.get("gender") else "")
                       + f"  · pos {d['pos']} · enZipf {d['enZipf']}")
            if d["entrSenses"]:
                out.append(f"- entrSenses: {json.dumps(d['entrSenses'], ensure_ascii=False)}")
            if d["currentTargetGlosses"]:
                out.append(f"- currentTargetGlosses: {json.dumps(d['currentTargetGlosses'], ensure_ascii=False)}")
            if d["omw"]:
                out.append(f"- omw: {json.dumps(d['omw'], ensure_ascii=False)}")
            if d["alternatives"]:
                out.append("- alternatives:")
                for a in d["alternatives"]:
                    out.append(
                        f"    - `{a['target']}` votes={a['votes']} sources={a['sources']} "
                        f"morph={json.dumps(a['morph'], ensure_ascii=False)} "
                        f"glosses={json.dumps(a['glosses'], ensure_ascii=False)}"
                    )
            out.append(f"- **engine reason**: {d['engineReason']}")
            out.append(f"- **gold**: keep — {d['goldRationale']}")
            out.append(f"- **verdict**: {d['classification']} — {d['reviewNote']}")
            out.append("")

    return "\n".join(out) + "\n"


def main() -> None:
    rows = build_joined_rows()
    report = build_report(rows)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    json_path = EVIDENCE_DIR / "gold2-gate.json"
    md_path = EVIDENCE_DIR / "gold2-gate.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")

    p = report["pooled"]
    print(f"n={p['n']} agreement={p['agreement']:.4f}")
    print(f"falseKeepRate={_fmt_pct(p['falseKeepRate'])} ({p['falseKeepCount']}/{p['goldBadCount']})  [informational]")
    print(f"shipStratumFalseChangeRate={_fmt_pct(p['shipStratumFalseChangeRate'])} "
          f"({p['shipStratumFalseChangeCount']}/{p['nShipChanges']})")
    print(f"adjShipFalseChange={_fmt_pct(p['adjShipFalseChange'])} "
          f"({p['engineWrongCount']}/{p['nShipChanges']}); goldSuspect={p['goldSuspectCount']}")
    print("")
    for lang in report["languages"]:
        m = report["perLanguage"][lang]
        print(f"[{lang}] n={m['n']} agreement={m['agreement']:.4f} "
              f"falseKeep={m['falseKeepCount']}/{m['goldBadCount']} "
              f"shipFalseChange={m['shipStratumFalseChangeCount']}/{m['nShipChanges']} "
              f"adjShipFalseChange={m['engineWrongCount']}/{m['nShipChanges']}")
    print(f"\nwrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
