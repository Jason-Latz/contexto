from __future__ import annotations

from dataclasses import dataclass, field


PartOfSpeech = str
FunctionSubtype = str


@dataclass(frozen=True)
class RawFreeDictEntry:
    source: str
    raw_pos: str
    translations: tuple[str, ...]
    definitions: tuple[str, ...]
    source_order: int


@dataclass
class ImportCandidate:
    source: str
    target: str
    part_of_speech: PartOfSpeech
    source_gloss: str
    confidence: str
    source_ids: list[str]
    source_order: int
    rank_priority: int
    gender: str | None = None
    plural: str | None = None
    function_subtype: FunctionSubtype | None = None
    diagnostics: list[str] = field(default_factory=list)

    def to_entry(self, frequency_rank: int) -> dict[str, object]:
        entry: dict[str, object] = {
            "source": self.source,
            "target": self.target,
            "partOfSpeech": self.part_of_speech,
            "sourceGloss": self.source_gloss,
            "frequencyRank": frequency_rank,
            "confidence": self.confidence,
            "sourceIds": self.source_ids,
        }

        if self.part_of_speech == "noun":
            entry["plural"] = self.plural
            entry["gender"] = self.gender

        if self.part_of_speech == "function":
            entry["functionSubtype"] = self.function_subtype

        return entry

