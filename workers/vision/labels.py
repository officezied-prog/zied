"""Detector label -> taxonomy category.

Detectors speak their training set's vocabulary ("short sleeve top",
"long_sleeved_outwear"); the product speaks the taxonomy. The mapping is data,
not code: it scores a label against every category's slug, display name and
`synonyms` column, so adding a category or a new detector vocabulary is an
INSERT, never a deploy.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset({"a", "the", "of", "with", "and", "for", "in", "s", "womens", "mens"})


def tokenize(text: str) -> frozenset[str]:
    return frozenset(t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS)


@dataclass(frozen=True)
class CategoryEntry:
    id: int
    slug: str
    display_name: str
    level: int
    default_role: str
    synonyms: tuple[str, ...] = ()

    @property
    def phrases(self) -> tuple[str, ...]:
        return (self.slug.replace("_", " "), self.display_name, *self.synonyms)


@dataclass(frozen=True)
class Match:
    category: CategoryEntry
    score: float
    matched_on: str


class CategoryMapper:
    def __init__(self, categories: list[CategoryEntry]) -> None:
        self.categories = categories
        self._exact: dict[str, CategoryEntry] = {}
        for c in categories:
            for phrase in c.phrases:
                key = " ".join(sorted(tokenize(phrase)))
                # A deeper category wins an exact tie: "denim jacket" should beat
                # the generic "jacket" when both match.
                if key and (key not in self._exact or c.level > self._exact[key].level):
                    self._exact[key] = c

    def map(self, label: str, *, min_score: float = 0.34) -> Match | None:
        tokens = tokenize(label)
        if not tokens:
            return None

        key = " ".join(sorted(tokens))
        if key in self._exact:
            return Match(self._exact[key], 1.0, "exact")

        best: Match | None = None
        for c in self.categories:
            for phrase in c.phrases:
                p_tokens = tokenize(phrase)
                if not p_tokens:
                    continue
                overlap = len(tokens & p_tokens)
                if not overlap:
                    continue
                # Jaccard, nudged by depth so specific categories outrank generic
                # ones at equal overlap.
                score = overlap / len(tokens | p_tokens) + 0.01 * c.level
                if best is None or score > best.score:
                    best = Match(c, round(min(score, 0.99), 4), f"partial:{phrase}")

        return best if best and best.score >= min_score else None


def build_mapper(rows) -> CategoryMapper:
    return CategoryMapper([
        CategoryEntry(
            id=r["id"], slug=r["slug"], display_name=r["display_name"],
            level=r["level"], default_role=str(r["default_role"]),
            synonyms=tuple(r["synonyms"] or ()),
        )
        for r in rows
    ])
