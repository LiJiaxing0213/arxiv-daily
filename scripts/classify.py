"""Classify papers into topics by keyword matching on title + abstract."""

from __future__ import annotations

import re

from config import TOPICS


def _compile_patterns() -> dict[str, list[re.Pattern]]:
    out = {}
    for key, t in TOPICS.items():
        out[key] = [
            re.compile(r"\b" + re.escape(kw) + r"\b", re.IGNORECASE)
            for kw in t["keywords"]
        ]
    return out


_PATTERNS = _compile_patterns()


def classify(paper: dict) -> list[str]:
    """Return list of topic keys this paper matches (may be empty or multiple)."""
    haystack = f"{paper.get('title', '')}  {paper.get('abstract', '')}"
    matched = []
    for topic_key, patterns in _PATTERNS.items():
        if any(p.search(haystack) for p in patterns):
            matched.append(topic_key)
    return matched


def filter_and_tag(papers: list[dict]) -> list[dict]:
    """Drop papers that match no topic; attach 'topics' field to the rest."""
    out = []
    for p in papers:
        topics = classify(p)
        if not topics:
            continue
        p2 = dict(p)
        p2["topics"] = topics
        out.append(p2)
    return out
