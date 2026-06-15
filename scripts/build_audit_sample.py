#!/usr/bin/env python3
"""Build reproducible translation-quality audit samples from the language pack.

Two samples (matching the overnight validation gate):
  A1 — frequency-weighted over the *shown* set (eligible AND renderable), weighted
       by 10**enZipf so it reflects what users actually see on a page.
  A2 — uniform over the *uncommon* band (enZipf < 4), including the deep tail;
       this is the "works for unique words" guarantee.

Renderable = the runtime gate in src/content/injector.ts:
  eligible == True AND (confidence == 'high' OR enZipf < MEDIUM_OK_ZIPF).

Output: JSON {"a1": [...], "a2": [...]} of compact records an agent panel can judge.
Deterministic given --seed. Usage:
  python scripts/build_audit_sample.py --n1 400 --n2 300 --seed 7 --out pipeline/data/audit_sample.json
"""
import argparse
import json
import random
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent / "public" / "language-packs" / "es.json"
MEDIUM_OK_ZIPF = 5.0  # keep in sync with injector.ts
UNCOMMON_MAX = 4.0


def renderable(v):
    return v.get("eligible") is True and (
        v.get("confidence") == "high" or v.get("enZipf", 0) < MEDIUM_OK_ZIPF
    )


def record(source, v):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n1", type=int, default=400)
    ap.add_argument("--n2", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--unverified-only", action="store_true",
                    help="restrict A1 to unverified medium entries (measures the changeable surface)")
    ap.add_argument("--out", default="pipeline/data/audit_sample.json")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    pack = json.loads(PACK.read_text())["entries"]

    shown = []
    uncommon = []
    for source, v in pack.items():
        if not renderable(v):
            continue
        if args.unverified_only and v.get("confidence") == "high":
            pass  # excluded from A1 pool below
        shown.append((source, v))
        if v.get("enZipf", 0) < UNCOMMON_MAX:
            uncommon.append((source, v))

    a1_pool = [(s, v) for (s, v) in shown
               if not (args.unverified_only and v.get("confidence") == "high")]
    # weighted-without-replacement sample by 10**enZipf
    weights = [10 ** v.get("enZipf", 0) for (_, v) in a1_pool]
    a1 = weighted_sample(rng, a1_pool, weights, min(args.n1, len(a1_pool)))
    a2 = rng.sample(uncommon, min(args.n2, len(uncommon)))

    out = {
        "meta": {
            "seed": args.seed,
            "shown_total": len(shown),
            "uncommon_total": len(uncommon),
            "unverified_only": args.unverified_only,
        },
        "a1": [record(s, v) for (s, v) in a1],
        "a2": [record(s, v) for (s, v) in a2],
    }
    outp = Path(args.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    outp.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"shown={len(shown)} uncommon={len(uncommon)}")
    print(f"wrote {outp}: a1={len(out['a1'])} a2={len(out['a2'])}")


def weighted_sample(rng, items, weights, k):
    # Efraimidis-Spirakis A-Res weighted sampling without replacement.
    keyed = []
    for it, w in zip(items, weights):
        if w <= 0:
            continue
        u = rng.random()
        keyed.append((u ** (1.0 / w), it))
    keyed.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in keyed[:k]]


if __name__ == "__main__":
    main()
