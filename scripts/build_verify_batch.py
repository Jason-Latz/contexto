#!/usr/bin/env python3
"""Build the next verification batch (frequency-first) as fixed-count chunk files.

Selects eligible words NOT yet processed tonight (tracked in a ledger), ordered by
enZipf descending (most-visible first), and writes exactly --chunks files of up to
--size words each into --outdir (chunk_000.json ...). The workflow reads those files.
Always writes --chunks files (padding with empty arrays) so the workflow script can
hardcode a constant chunk count.

The ledger is advanced by apply_verify_decisions.py after a batch's decisions are
applied — NOT here — so a crashed or lost workflow run leaves its words un-ledgered
and the next build re-queues them (no silent coverage loss).

Usage:
  python scripts/build_verify_batch.py --chunks 100 --size 30
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "public" / "language-packs" / "es.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", type=int, default=100)
    ap.add_argument("--size", type=int, default=30)
    ap.add_argument("--outdir", default="pipeline/data/verify")
    ap.add_argument("--ledger", default="pipeline/data/verify_ledger.json")
    ap.add_argument("--max-zipf", type=float, default=99.0,
                    help="only queue words with enZipf <= this (to target the tail later)")
    ap.add_argument("--min-zipf", type=float, default=-1.0)
    ap.add_argument("--conf", choices=["any", "medium", "high"], default="any")
    args = ap.parse_args()

    pack = json.loads(PACK.read_text())["entries"]
    ledger_path = Path(args.ledger)
    done = set(json.loads(ledger_path.read_text())) if ledger_path.exists() else set()

    pool = []
    for source, v in pack.items():
        if v.get("eligible") is not True:
            continue
        if source in done:
            continue
        z = v.get("enZipf", 0)
        if not (args.min_zipf <= z <= args.max_zipf):
            continue
        if args.conf != "any" and v.get("confidence") != args.conf:
            continue
        pool.append((source, v))

    pool.sort(key=lambda kv: kv[1].get("enZipf", 0), reverse=True)
    capacity = args.chunks * args.size
    batch = pool[:capacity]

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    # clear old chunks
    for f in outdir.glob("chunk_*.json"):
        f.unlink()

    def rec(source, v):
        r = {
            "source": source,
            "target": v.get("target"),
            "partOfSpeech": v.get("partOfSpeech"),
            "gloss": v.get("sourceGloss"),
            "enZipf": round(v.get("enZipf", 0), 2),
            "confidence": v.get("confidence"),
        }
        if v.get("partOfSpeech") == "noun":
            r["gender"] = v.get("gender")
            r["plural"] = v.get("plural")
        return r

    queued = []
    for i in range(args.chunks):
        chunk = batch[i * args.size:(i + 1) * args.size]
        recs = [rec(s, v) for (s, v) in chunk]
        (outdir / f"chunk_{i:03d}.json").write_text(json.dumps(recs, ensure_ascii=False, indent=1))
        queued.extend(s for (s, v) in chunk)

    # NOTE: the ledger is advanced by apply_verify_decisions.py AFTER decisions are
    # applied — not here. A crashed/lost workflow run therefore leaves its words
    # un-ledgered, and the next frequency-first build re-queues them naturally
    # (no silent coverage loss).

    zmin = round(min((v.get("enZipf", 0) for _, v in batch), default=0), 2)
    zmax = round(max((v.get("enZipf", 0) for _, v in batch), default=0), 2)
    print(f"queued {len(queued)} words into {args.chunks} chunks (size {args.size})")
    print(f"  enZipf range this batch: {zmax} .. {zmin}")
    print(f"  pool remaining after this batch: {len(pool) - len(batch)}")
    print(f"  ledger (already verified, pre-batch): {len(done)}")


if __name__ == "__main__":
    main()
