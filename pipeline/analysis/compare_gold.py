#!/usr/bin/env python3
"""Score the engine's gold-set verdicts against the hand-built answer key.

This is "attempt 2": the fixup overrides were revised after attempt 1's report
was generated (e.g. `churl` in gold-mixed-6.jsonl flipped from a "change"-verdict
retarget to a clean "retarget", and the `amenity` fixup on shard 0 moved from
retarget to keep) -- attempt 1's numbers are stale. Rerunning against the same
final/ + refreshed fixup/ inputs regrades on the current data. Attempt 1's
evidence files are left in place for comparison; this run writes
`gold-gate-attempt2.{json,md}` instead of overwriting them.

Inputs:
  pipeline/data/verdicts/final/gold-mixed-{0..8}.jsonl  - engine adjudication
      output (one shard per file): {key, verdict, newTarget, newGender,
      newPlural, morphAuthority, pos, confidence, reason, refuter?,
      refuterReason?}. verdict in {"keep", "retarget", "gate"}.
  pipeline/data/verdicts/fixup/gold-mixed-{0..8}.jsonl  - opus-judge overrides
      for disputed rows, same shape (no "refuter", adds "judge"). A fixup row
      REPLACES the final row for the same `key` before comparison -- mirrors
      apply_verdicts.py's effective_rows() ("fixup wins").
  pipeline/data/queues/gold-answers.jsonl               - the answer key:
      {lang, key, verdict, correctedTarget, ..., rationale}. verdict in
      {"keep", "retarget", "gate"}.
  pipeline/data/queues/gold-queue.jsonl                 - the queue rows fed
      to the engine; used only to surface the pre-verdict `target` in the
      quoted examples below.

Join strategy: POSITIONAL, not by key. gold-queue.jsonl, gold-answers.jsonl,
and the concatenation of final/gold-mixed-{0..8}.jsonl (in shard order) are
all 399 rows long and were generated in lockstep from the same underlying
order -- verified empirically (see docs below). Joining by key alone is unsafe
because the key "go" repeats across two different languages (fr and es) at
two different positions; fixup overrides stay position-safe because they are
matched by `key` only *within* their own shard, where keys ARE unique.

Metrics (per language and pooled, each with n):
  agreement       - exact verdict match rate (engine verdict == gold verdict).
  falseKeepRate   - among gold rows that say retarget/gate (a real problem),
                    the fraction the engine called "keep" (a wrong word left
                    in the pack). Denominator: count(gold in {retarget, gate}).
  falseChangeRate - among gold rows that say keep (a genuinely good entry),
                    the fraction the engine called retarget/gate (a good word
                    corrupted or removed). Denominator: count(gold == keep).

Output:
  pipeline/data/evidence/gold-gate-attempt2.json - full metrics + confusion
      matrices + quoted example failures, machine-readable.
  pipeline/data/evidence/gold-gate-attempt2.md   - human-readable render.

Usage:
    python3 pipeline/analysis/compare_gold.py
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

SHARD_COUNT = 9
VERDICTS = ("keep", "retarget", "gate")

# Attempt 1 hit a fixup row (gold-mixed-6.jsonl, key "churl") using verdict
# "change" instead of the standard {keep, retarget, gate} enum -- it set
# newTarget/newGender/newPlural exactly like a retarget row does, so it was a
# retarget in every way except spelling. That source row has since been fixed
# to say "retarget" directly. The alias is kept as a harmless safety net (any
# row hitting it is also recorded in `anomalies` so a recurrence is visible,
# not silently miscounted as a disagreement).
VERDICT_ALIASES = {"change": "retarget"}


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def effective_shard_rows(shard_index: int) -> list[dict]:
    """Final rows for one gold-mixed shard with matching fixup rulings
    substituted in by `key` (keys are unique within a shard). Order preserved."""
    final_rows = load_jsonl(FINAL_DIR / f"gold-mixed-{shard_index}.jsonl")
    fixup_rows = load_jsonl(FIXUP_DIR / f"gold-mixed-{shard_index}.jsonl")
    fixup_by_key = {row["key"]: row for row in fixup_rows if "key" in row}
    return [fixup_by_key.get(row.get("key"), row) for row in final_rows]


def normalize_verdict(raw: str, key: str, anomalies: list[dict]) -> str:
    if raw in VERDICTS:
        return raw
    normalized = VERDICT_ALIASES.get(raw)
    if normalized is not None:
        anomalies.append({"key": key, "rawVerdict": raw, "normalizedTo": normalized})
        return normalized
    anomalies.append({"key": key, "rawVerdict": raw, "normalizedTo": None})
    return raw


def truncate(text, limit: int = 220) -> str:
    if not isinstance(text, str):
        return text
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_joined_rows() -> tuple[list[dict], list[dict]]:
    """Returns (joined_rows, anomalies). joined_rows are positionally aligned
    across engine/gold/queue; anomalies records off-spec verdict strings and
    any key mismatch found at join time (would indicate the shards drifted
    out of lockstep with the queue/answers files)."""
    engine_rows: list[dict] = []
    for i in range(SHARD_COUNT):
        engine_rows.extend(effective_shard_rows(i))

    answer_rows = load_jsonl(QUEUES_DIR / "gold-answers.jsonl")
    queue_rows = load_jsonl(QUEUES_DIR / "gold-queue.jsonl")

    if not (len(engine_rows) == len(answer_rows) == len(queue_rows)):
        raise SystemExit(
            f"row count mismatch: engine={len(engine_rows)} "
            f"answers={len(answer_rows)} queue={len(queue_rows)}"
        )

    anomalies: list[dict] = []
    joined = []
    for i, (engine, answer, queue) in enumerate(zip(engine_rows, answer_rows, queue_rows)):
        if engine.get("key") != answer.get("key") or answer.get("key") != queue.get("key"):
            anomalies.append({
                "position": i,
                "issue": "key-mismatch-at-join",
                "engineKey": engine.get("key"),
                "answerKey": answer.get("key"),
                "queueKey": queue.get("key"),
            })
            continue
        engine_verdict = normalize_verdict(engine.get("verdict"), engine.get("key"), anomalies)
        joined.append({
            "position": i,
            "lang": answer.get("lang"),
            "key": answer.get("key"),
            "engineVerdict": engine_verdict,
            "engineVerdictRaw": engine.get("verdict"),
            "engineNewTarget": engine.get("newTarget"),
            "engineReason": engine.get("reason"),
            "engineJudge": engine.get("judge"),  # present only when a fixup row won
            "goldVerdict": answer.get("verdict"),
            "goldCorrectedTarget": answer.get("correctedTarget"),
            "goldRationale": answer.get("rationale"),
            "currentTarget": queue.get("target"),
        })
    return joined, anomalies


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


def metrics_for(rows: list[dict]) -> dict:
    n = len(rows)
    if n == 0:
        return {"n": 0, "agreement": None, "falseKeepRate": None, "falseChangeRate": None,
                "confusionMatrix": confusion_matrix(rows)}

    agree = sum(1 for r in rows if r["engineVerdict"] == r["goldVerdict"])

    gold_bad = [r for r in rows if r["goldVerdict"] in ("retarget", "gate")]
    false_keep = [r for r in gold_bad if r["engineVerdict"] == "keep"]

    gold_good = [r for r in rows if r["goldVerdict"] == "keep"]
    false_change = [r for r in gold_good if r["engineVerdict"] in ("retarget", "gate")]

    return {
        "n": n,
        "agreement": agree / n,
        "falseKeepRate": (len(false_keep) / len(gold_bad)) if gold_bad else None,
        "falseKeepCount": len(false_keep),
        "goldBadCount": len(gold_bad),
        "falseChangeRate": (len(false_change) / len(gold_good)) if gold_good else None,
        "falseChangeCount": len(false_change),
        "goldGoodCount": len(gold_good),
        "confusionMatrix": confusion_matrix(rows),
        "_falseKeepExamples": false_keep,
        "_falseChangeExamples": false_change,
    }


def pick_examples(rows: list[dict], limit: int = 4) -> list[dict]:
    picked = []
    for row in rows[:limit]:
        picked.append({
            "lang": row["lang"],
            "key": row["key"],
            "currentTarget": row["currentTarget"],
            "engineVerdict": row["engineVerdictRaw"],
            "engineNewTarget": row["engineNewTarget"],
            "engineReason": truncate(row["engineReason"]),
            "goldVerdict": row["goldVerdict"],
            "goldCorrectedTarget": row["goldCorrectedTarget"],
            "goldRationale": truncate(row["goldRationale"]),
        })
    return picked


def build_report(rows: list[dict], anomalies: list[dict]) -> dict:
    langs = sorted({r["lang"] for r in rows})
    per_language = {}
    for lang in langs:
        lang_rows = [r for r in rows if r["lang"] == lang]
        m = metrics_for(lang_rows)
        m["falseKeepExamples"] = pick_examples(m.pop("_falseKeepExamples"))
        m["falseChangeExamples"] = pick_examples(m.pop("_falseChangeExamples"))
        per_language[lang] = m

    pooled = metrics_for(rows)
    pooled["falseKeepExamples"] = pick_examples(pooled.pop("_falseKeepExamples"), limit=8)
    pooled["falseChangeExamples"] = pick_examples(pooled.pop("_falseChangeExamples"), limit=8)

    return {
        "source": "gold-gate-attempt2",
        "n": len(rows),
        "languages": langs,
        "perLanguage": per_language,
        "pooled": pooled,
        "anomalies": anomalies,
    }


def render_markdown(report: dict) -> str:
    lines = []
    lines.append("# Gold-gate comparison -- attempt 2")
    lines.append("")
    lines.append(
        f"Engine gold verdicts (`final/gold-mixed-*.jsonl` + `fixup/gold-mixed-*.jsonl` "
        f"overrides) vs. the answer key (`queues/gold-answers.jsonl`). n = {report['n']}."
    )
    lines.append("")

    def render_bucket(name: str, m: dict) -> list[str]:
        out = [f"## {name} (n={m['n']})", ""]
        if m["n"] == 0:
            out.append("_no rows_")
            return out
        out.append(f"- agreement: **{m['agreement']:.1%}**")
        fk = f"{m['falseKeepRate']:.1%}" if m["falseKeepRate"] is not None else "n/a"
        fc = f"{m['falseChangeRate']:.1%}" if m["falseChangeRate"] is not None else "n/a"
        out.append(f"- falseKeepRate: **{fk}** ({m['falseKeepCount']}/{m['goldBadCount']} gold retarget/gate rows called keep)")
        out.append(f"- falseChangeRate: **{fc}** ({m['falseChangeCount']}/{m['goldGoodCount']} gold keep rows called retarget/gate)")
        out.append("")
        out.append("Confusion matrix (rows = gold verdict, cols = engine verdict):")
        out.append("")
        cm = m["confusionMatrix"]["goldRowsByEngineVerdict"]
        out.append("| gold \\ engine | keep | retarget | gate |")
        out.append("|---|---|---|---|")
        for g in VERDICTS:
            out.append(f"| {g} | {cm[g]['keep']} | {cm[g]['retarget']} | {cm[g]['gate']} |")
        if m["confusionMatrix"].get("unmatchedPairs"):
            out.append("")
            out.append(f"Unmatched verdict pairs (off-enum values): {m['confusionMatrix']['unmatchedPairs']}")
        out.append("")
        if m["falseKeepExamples"]:
            out.append("**False-keep examples** (engine kept a word gold says is wrong):")
            out.append("")
            for ex in m["falseKeepExamples"]:
                out.append(
                    f"- `{ex['key']}` ({ex['lang']}, current target `{ex['currentTarget']}`): "
                    f"engine=keep -- \"{ex['engineReason']}\"; "
                    f"gold={ex['goldVerdict']}"
                    + (f"->`{ex['goldCorrectedTarget']}`" if ex['goldCorrectedTarget'] else "")
                    + f" -- \"{ex['goldRationale']}\""
                )
            out.append("")
        if m["falseChangeExamples"]:
            out.append("**False-change examples** (engine changed a word gold says was fine):")
            out.append("")
            for ex in m["falseChangeExamples"]:
                out.append(
                    f"- `{ex['key']}` ({ex['lang']}, current target `{ex['currentTarget']}`): "
                    f"engine={ex['engineVerdict']}"
                    + (f"->`{ex['engineNewTarget']}`" if ex['engineNewTarget'] else "")
                    + f" -- \"{ex['engineReason']}\"; "
                    f"gold=keep -- \"{ex['goldRationale']}\""
                )
            out.append("")
        return out

    for lang in report["languages"]:
        lines.extend(render_bucket(f"Language: {lang}", report["perLanguage"][lang]))

    lines.extend(render_bucket("Pooled (all languages)", report["pooled"]))

    if report["anomalies"]:
        lines.append("## Anomalies")
        lines.append("")
        lines.append(
            "Off-spec verdict strings or join mismatches encountered while scoring "
            "(does not include normal keep/retarget/gate disagreements, which are "
            "counted in the confusion matrices above):"
        )
        lines.append("")
        for a in report["anomalies"]:
            lines.append(f"- {json.dumps(a, ensure_ascii=False)}")
        lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    rows, anomalies = build_joined_rows()
    report = build_report(rows, anomalies)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    json_path = EVIDENCE_DIR / "gold-gate-attempt2.json"
    md_path = EVIDENCE_DIR / "gold-gate-attempt2.md"

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")

    pooled = report["pooled"]
    print(f"n={pooled['n']}")
    print(f"agreement={pooled['agreement']:.4f}")
    print(f"falseKeepRate={pooled['falseKeepRate']:.4f} ({pooled['falseKeepCount']}/{pooled['goldBadCount']})")
    print(f"falseChangeRate={pooled['falseChangeRate']:.4f} ({pooled['falseChangeCount']}/{pooled['goldGoodCount']})")
    print("")
    for lang in report["languages"]:
        m = report["perLanguage"][lang]
        print(f"[{lang}] n={m['n']} agreement={m['agreement']:.4f} "
              f"falseKeepRate={m['falseKeepRate']:.4f} falseChangeRate={m['falseChangeRate']:.4f}")
    if anomalies:
        print(f"\n{len(anomalies)} anomalies -- see {json_path.name}")
    print(f"\nwrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
