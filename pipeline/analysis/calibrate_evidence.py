#!/usr/bin/env python3
"""Calibrate the deterministic evidence buckets against the human/Opus gold set.

Joins pipeline/data/gold/gold.jsonl to pipeline/data/evidence/{lang}-evidence.jsonl
by (lang, normalized source), then measures how trustworthy each evidence
`resolution` bucket is against the gold verdict (keep/retarget/gate) and the
gold genderOk/pluralOk labels.

Outputs:
  pipeline/data/evidence/calibration.json       (all metrics, per-lang + pooled)
  pipeline/data/evidence/calibration-report.md   (readable, with example disagreements)
"""
from __future__ import annotations
import json
from collections import defaultdict, Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GOLD = REPO / "pipeline" / "data" / "gold" / "gold.jsonl"
EVDIR = REPO / "pipeline" / "data" / "evidence"
LANGS = ["es", "de", "fr", "it"]
BUCKETS = ["confirm", "flag-retarget", "flag-gender", "flag-plural", "ambiguous", "no-evidence"]


def norm(s):
    return " ".join(s.strip().lower().split()) if s else ""


def load_evidence():
    idx = {}
    for lang in LANGS:
        p = EVDIR / f"{lang}-evidence.jsonl"
        for line in open(p, encoding="utf-8"):
            r = json.loads(line)
            idx[(lang, norm(r.get("source")))] = r
    return idx


def load_gold():
    rows = []
    for line in open(GOLD, encoding="utf-8"):
        rows.append(json.loads(line))
    return rows


def pct(num, den):
    return (num / den) if den else None


def main():
    ev = load_evidence()
    gold = load_gold()

    # join
    joined = []  # (gold, evidence)
    unmatched = 0
    for g in gold:
        key = (g["lang"], norm(g.get("source")))
        e = ev.get(key)
        if e is None:
            unmatched += 1
            continue
        joined.append((g, e))

    # ---- per (lang or pooled) x bucket -> gold verdict distribution ----
    def blank_bucket():
        return {
            "n": 0,
            "verdict": Counter(),          # keep/retarget/gate
            "genderOk_false": 0, "genderOk_true": 0, "genderOk_null": 0,
            "pluralOk_false": 0, "pluralOk_true": 0, "pluralOk_null": 0,
        }

    # scopes: 'pooled', 'es','de','fr','it', plus 'de+fr+it' (wiktextract-inverted)
    scopes = ["pooled", "es", "de", "fr", "it", "defrit"]
    stats = {sc: {b: blank_bucket() for b in BUCKETS} for sc in scopes}
    # provenance split too
    prov_stats = {"prior-audit": {b: blank_bucket() for b in BUCKETS},
                  "fresh": {b: blank_bucket() for b in BUCKETS}}

    examples = defaultdict(list)  # bucket -> list of disagreement examples

    for g, e in joined:
        lang = g["lang"]
        res = e["resolution"]
        v = g["verdict"]
        gscopes = ["pooled", lang]
        if lang in ("de", "fr", "it"):
            gscopes.append("defrit")
        for sc in gscopes:
            b = stats[sc][res]
            b["n"] += 1
            b["verdict"][v] += 1
            for fld, pre in (("genderOk", "genderOk"), ("pluralOk", "pluralOk")):
                val = g.get(fld)
                if val is True:
                    b[pre + "_true"] += 1
                elif val is False:
                    b[pre + "_false"] += 1
                else:
                    b[pre + "_null"] += 1
        pb = prov_stats[g.get("provenance", "?")][res]
        pb["n"] += 1
        pb["verdict"][v] += 1
        for fld, pre in (("genderOk", "genderOk"), ("pluralOk", "pluralOk")):
            val = g.get(fld)
            if val is True: pb[pre + "_true"] += 1
            elif val is False: pb[pre + "_false"] += 1
            else: pb[pre + "_null"] += 1

        # collect example disagreements
        wrong_ship = res == "confirm" and v in ("retarget", "gate")
        bad_retarget = res == "flag-retarget" and v == "keep"
        bad_gender = res == "flag-gender" and g.get("genderOk") is True
        bad_plural = res == "flag-plural" and g.get("pluralOk") is True
        if wrong_ship:
            examples["confirm_FP"].append((g, e))
        if bad_retarget:
            examples["flag-retarget_FP"].append((g, e))
        if bad_gender:
            examples["flag-gender_FP"].append((g, e))
        if bad_plural:
            examples["flag-plural_FP"].append((g, e))

    # ---- headline metrics per scope ----
    def bucket_metrics(b):
        n = b["n"]
        keep = b["verdict"].get("keep", 0)
        retarget = b["verdict"].get("retarget", 0)
        gate = b["verdict"].get("gate", 0)
        m = {
            "n": n,
            "keep": keep, "retarget": retarget, "gate": gate,
            "p_keep": pct(keep, n), "p_retarget": pct(retarget, n), "p_gate": pct(gate, n),
        }
        return m

    metrics = {}
    for sc in scopes:
        sc_m = {}
        for bkt in BUCKETS:
            sc_m[bkt] = bucket_metrics(stats[sc][bkt])
        cb = stats[sc]["confirm"]
        cn = cb["n"]
        confirm_wrong = cb["verdict"].get("retarget", 0) + cb["verdict"].get("gate", 0)
        rb = stats[sc]["flag-retarget"]
        rn = rb["n"]
        rt_strict = rb["verdict"].get("retarget", 0)
        rt_wrong = rb["verdict"].get("retarget", 0) + rb["verdict"].get("gate", 0)  # current-target-wrong
        # gender flag precision (over rows with a non-null genderOk label)
        gb = stats[sc]["flag-gender"]
        g_lab = gb["genderOk_false"] + gb["genderOk_true"]
        # plural flag precision
        plb = stats[sc]["flag-plural"]
        p_lab = plb["pluralOk_false"] + plb["pluralOk_true"]
        sc_m["_headline"] = {
            "confirm_n": cn,
            "confirmFalsePositiveRate": pct(confirm_wrong, cn),
            "confirm_wrong_count": confirm_wrong,
            "flag_retarget_n": rn,
            "retargetPrecision_currentWrong": pct(rt_wrong, rn),  # gold says current wrong (retarget|gate)
            "retargetPrecision_strict": pct(rt_strict, rn),       # gold says exactly retarget
            "flag_gender_n": gb["n"], "flag_gender_labeled": g_lab,
            "genderFlagPrecision": pct(gb["genderOk_false"], g_lab),
            "flag_plural_n": plb["n"], "flag_plural_labeled": p_lab,
            "pluralFlagPrecision": pct(plb["pluralOk_false"], p_lab),
        }
        metrics[sc] = sc_m

    # ---- confirm FP as a function of nVotesCurrent threshold (pooled + es) ----
    vote_sweep = {}
    for sc in ["pooled", "es", "defrit"]:
        sweep = {}
        for thr in [2, 3, 4]:
            n = wrong = 0
            for g, e in joined:
                if sc == "es" and g["lang"] != "es":
                    continue
                if sc == "defrit" and g["lang"] not in ("de", "fr", "it"):
                    continue
                if e["resolution"] != "confirm":
                    continue
                if e.get("nVotesCurrent", 0) < thr:
                    continue
                n += 1
                if g["verdict"] in ("retarget", "gate"):
                    wrong += 1
            sweep[f"votes>={thr}"] = {"n": n, "wrong": wrong, "fpRate": pct(wrong, n)}
        vote_sweep[sc] = sweep

    # ---- combined auto-apply filter analysis on the confirm bucket ----
    def is_propn_or_multiword(e):
        t = (e.get("target") or "").strip()
        if not t:
            return False
        return t[0].isupper() or (" " in t)

    def confirm_filter(scope, pred):
        n = wrong = 0
        for g, e in joined:
            if scope == "es" and g["lang"] != "es":
                continue
            if scope == "defrit" and g["lang"] not in ("de", "fr", "it"):
                continue
            if e["resolution"] != "confirm":
                continue
            if not pred(g, e):
                continue
            n += 1
            if g["verdict"] in ("retarget", "gate"):
                wrong += 1
        return {"n": n, "wrong": wrong, "fpRate": pct(wrong, n)}

    autoapply = {}
    for scope in ("pooled", "es", "defrit"):
        autoapply[scope] = {
            "confirm_raw": confirm_filter(scope, lambda g, e: True),
            "confirm_no_propn_multiword": confirm_filter(scope, lambda g, e: not is_propn_or_multiword(e)),
            "confirm_no_propn_multiword_votes>=3": confirm_filter(
                scope, lambda g, e: (not is_propn_or_multiword(e)) and e.get("nVotesCurrent", 0) >= 3),
            "confirm_votes>=3": confirm_filter(scope, lambda g, e: e.get("nVotesCurrent", 0) >= 3),
        }

    out = {
        "join": {
            "gold_total": len(gold),
            "joined": len(joined),
            "unmatched": unmatched,
        },
        "gold_composition": {
            "by_lang": dict(Counter(g["lang"] for g in gold)),
            "by_provenance": dict(Counter(g.get("provenance") for g in gold)),
            "by_verdict": dict(Counter(g["verdict"] for g in gold)),
        },
        "metrics": metrics,
        "confirm_vote_threshold_sweep": vote_sweep,
        "confirm_autoapply_filters": autoapply,
        "provenance_confirm": {
            prov: {
                "confirm_n": prov_stats[prov]["confirm"]["n"],
                "confirmFalsePositiveRate": pct(
                    prov_stats[prov]["confirm"]["verdict"].get("retarget", 0)
                    + prov_stats[prov]["confirm"]["verdict"].get("gate", 0),
                    prov_stats[prov]["confirm"]["n"]),
            } for prov in ("prior-audit", "fresh")
        },
    }

    (EVDIR / "calibration.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")

    # stash examples for the report
    with open(EVDIR / "_calib_examples.json", "w", encoding="utf-8") as f:
        ser = {}
        for k, lst in examples.items():
            ser[k] = [{
                "lang": g["lang"], "source": g.get("source"), "gold_target": g.get("target"),
                "ev_target": e.get("target"), "verdict": g["verdict"],
                "correctedTarget": g.get("correctedTarget"),
                "genderOk": g.get("genderOk"), "pluralOk": g.get("pluralOk"),
                "nVotesCurrent": e.get("nVotesCurrent"),
                "bestAlternative": e.get("bestAlternative"),
                "rationale": g.get("rationale"),
                "provenance": g.get("provenance"),
            } for g, e in lst]
        json.dump(ser, f, indent=2, ensure_ascii=False)

    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
