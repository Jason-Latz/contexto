#!/usr/bin/env python3
"""Remove audit-flagged sources from the verify ledger so the next batch re-verifies them.

The adversarial audits emit a `flagged` list of sources judged wrong_sense/wrong_form
(including already-"high" entries the verification missed). Un-ledgering them returns
them to the verification pool; because they are typically high-frequency, the next
frequency-first build_verify_batch picks them up first and re-verifies/corrects them.

Usage:
  python scripts/requeue_flagged.py pipeline/data/audit_run1.json pipeline/data/audit_run2.json
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "pipeline" / "data" / "verify_ledger.json"


def flagged_sources(audit_path):
    raw = json.loads(Path(audit_path).read_text())
    result = raw.get("result", raw)
    return [f["source"] for f in result.get("flagged", []) if f.get("source")]


def main(paths):
    flagged = set()
    for p in paths:
        flagged.update(flagged_sources(p))
    done = set(json.loads(LEDGER.read_text())) if LEDGER.exists() else set()
    before = len(done)
    removed = flagged & done
    done -= flagged
    LEDGER.write_text(json.dumps(sorted(done), ensure_ascii=False))
    print(f"flagged={len(flagged)} re-queued (removed from ledger)={len(removed)} "
          f"ledger {before}->{len(done)}")
    # also report flagged that were NOT in ledger (will be queued naturally)
    print("re-queued sample:", sorted(removed)[:20])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/requeue_flagged.py <audit.json> [audit2.json ...]")
    main(sys.argv[1:])
