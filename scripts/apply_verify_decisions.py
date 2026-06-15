#!/usr/bin/env python3
"""Transform a verify-pack-batch workflow result into apply_curation's input.

Reads the workflow .output file (a JSON object whose return value is under
".result", with ".result.decisions" = [{source, action, target, partOfSpeech,
gender, plural, reason}]). Emits {curated, skipped} JSON for apply_curation.py.

- action "keep"/"fix" -> curated (target falls back to the pack's current target
  if the agent omitted it on a keep).
- action "skip"      -> skipped (eligible:false).
- Noun decisions missing gender/plural are reported as incomplete (apply_curation
  will reject them; they stay as-is).

Usage:
  python scripts/apply_verify_decisions.py <workflow.output> [--out pipeline/data/verify_decisions.json]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "public" / "language-packs" / "es.json"
LEDGER = ROOT / "pipeline" / "data" / "verify_ledger.json"


def find(entries, source):
    return entries.get(source) or entries.get(source.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output_file")
    ap.add_argument("--out", default="pipeline/data/verify_decisions.json")
    args = ap.parse_args()

    raw = json.loads(Path(args.output_file).read_text())
    result = raw.get("result", raw)
    decisions = result.get("decisions", [])

    entries = json.loads(PACK.read_text())["entries"]

    curated, skipped, incomplete = [], [], []
    seen = set()
    for d in decisions:
        src = d.get("source")
        if not src or src in seen:
            continue
        seen.add(src)
        action = d.get("action")
        e = find(entries, src)
        if not e:
            continue
        if action == "skip":
            skipped.append(src)
            continue
        # keep or fix
        pos = (d.get("partOfSpeech") or e.get("partOfSpeech") or "").strip()
        target = (d.get("target") or "").strip()
        if not target and action == "keep":
            target = (e.get("target") or "").strip()
        if not target:
            incomplete.append((src, "no target"))
            continue
        item = {"source": src, "target": target, "partOfSpeech": pos}
        if pos == "noun":
            gender = (d.get("gender") or e.get("gender") or "").strip()
            plural = (d.get("plural") or e.get("plural") or "").strip()
            if gender not in ("masculine", "feminine") or not plural:
                incomplete.append((src, f"noun missing gender/plural ({action})"))
                continue
            item["gender"] = gender
            item["plural"] = plural
        curated.append(item)

    out = {"curated": curated, "skipped": skipped}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))

    # Advance the ledger by the sources we actually have decisions for (commit-after-apply
    # semantics — see build_verify_batch.py). Words with no decision stay un-ledgered and
    # get re-queued by the next build.
    decided = {d.get("source") for d in decisions if d.get("source")}
    done = set(json.loads(LEDGER.read_text())) if LEDGER.exists() else set()
    before = len(done)
    done |= decided
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(sorted(done), ensure_ascii=False))

    print(f"decisions={len(decisions)} -> curated={len(curated)} skipped={len(skipped)} incomplete={len(incomplete)}")
    for s in incomplete[:15]:
        print("   incomplete:", s)
    print(f"wrote {args.out}; ledger {before} -> {len(done)}")


if __name__ == "__main__":
    main()
