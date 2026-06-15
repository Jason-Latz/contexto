#!/usr/bin/env python3
"""Build the golden regression set: tests/fixtures/golden-es.json.

Two kinds of entries:
  - "hand": independently-authored ground truth — source must map to one of a set
    of acceptable Spanish targets, and be eligible + high. These validate real
    correctness (incl. false-friend traps the audit surfaced).
  - "snapshot": a stratified sample of currently-verified (high+eligible) entries
    with their exact target/gender/plural, to guard against future regressions.

Run AFTER the verification passes so it reflects the shipped pack:
  python scripts/build_golden.py
"""
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "public" / "language-packs" / "es.json"
OUT = ROOT / "tests" / "fixtures" / "golden-es.json"

# Independently-authored ground truth: source -> set of acceptable targets.
# Includes common vocabulary AND the classic false friends the audit flagged.
HAND = {
    # common nouns
    "house": ["casa"], "dog": ["perro"], "cat": ["gato"], "water": ["agua"],
    "book": ["libro"], "city": ["ciudad"], "man": ["hombre"], "woman": ["mujer"],
    "day": ["día"], "night": ["noche"], "food": ["comida"], "friend": ["amigo"],
    "school": ["escuela", "colegio"], "tree": ["árbol"], "street": ["calle"],
    "world": ["mundo"], "year": ["año"], "hand": ["mano"], "eye": ["ojo"],
    "door": ["puerta"], "table": ["mesa"], "name": ["nombre"], "river": ["río"],
    "country": ["país"], "money": ["dinero"], "child": ["niño"], "mother": ["madre"],
    "father": ["padre"], "head": ["cabeza"], "heart": ["corazón"], "word": ["palabra"],
    # common verbs (acceptable sets widened for POS-ambiguous headwords)
    "eat": ["comer"], "drink": ["beber"], "run": ["correr", "carrera"], "read": ["leer"],
    "write": ["escribir"], "speak": ["hablar"], "walk": ["caminar", "andar", "paseo"],
    "sleep": ["dormir"], "buy": ["comprar"], "sell": ["vender"],
    "live": ["vivir", "en vivo", "en directo"], "open": ["abrir", "abierto"],
    "close": ["cerrar", "cercano", "cerca"], "learn": ["aprender"], "teach": ["enseñar"],
    # common adjectives
    "big": ["grande"], "small": ["pequeño"], "good": ["bueno"], "bad": ["malo"],
    "new": ["nuevo"], "old": ["viejo"], "happy": ["feliz", "contento"],
    "cold": ["frío"], "easy": ["fácil"], "difficult": ["difícil"], "strong": ["fuerte"],
    # false-friend / dominant-sense traps from the audit
    "library": ["biblioteca"], "embarrassed": ["avergonzado"], "carpet": ["alfombra"],
    "angle": ["ángulo"], "actually": ["en realidad", "realmente", "de hecho"],
    "exit": ["salida"], "success": ["éxito"], "support": ["apoyo", "apoyar", "soporte", "sostener"],
    "fabric": ["tela", "tejido", "entramado"], "sensible": ["sensato", "razonable"],
    "rope": ["cuerda", "soga"], "soup": ["sopa"], "bridge": ["puente"],
    "fish": ["pez", "pescado"],
}


def find(entries, source):
    return entries.get(source) or entries.get(source.lower())


def main():
    rng = random.Random(11)
    entries = json.loads(PACK.read_text())["entries"]
    golden = []

    for source, acceptable in HAND.items():
        golden.append({"source": source, "kind": "hand", "acceptable": acceptable})

    hand_sources = {s.lower() for s in HAND}
    # stratified snapshot of verified entries across frequency bands
    bands = {"common": (4.5, 9), "mid": (3.5, 4.5), "rare": (2.0, 3.5), "deep": (-1, 2.0)}
    per_band = 28
    for _name, (lo, hi) in bands.items():
        pool = [
            (s, v) for s, v in entries.items()
            if v.get("confidence") == "high" and v.get("eligible") is True
            and lo <= v.get("enZipf", 0) < hi and s.lower() not in hand_sources
            and v.get("target")
        ]
        rng.shuffle(pool)
        for s, v in pool[:per_band]:
            item = {"source": s, "kind": "snapshot", "target": v["target"],
                    "partOfSpeech": v.get("partOfSpeech")}
            if v.get("partOfSpeech") == "noun":
                item["gender"] = v.get("gender")
                item["plural"] = v.get("plural")
            golden.append(item)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT}: {len(golden)} entries "
          f"({sum(1 for g in golden if g['kind']=='hand')} hand, "
          f"{sum(1 for g in golden if g['kind']=='snapshot')} snapshot)")


if __name__ == "__main__":
    main()
