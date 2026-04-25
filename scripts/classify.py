"""Classify papers into topics by keyword matching on title + abstract.

Each topic has positive `keywords` (any match -> belongs) and optional
`exclude` (any match -> drop from this topic). There's also a GLOBAL_EXCLUDE
that drops papers from all topics.
"""

from __future__ import annotations

import re

from config import GLOBAL_EXCLUDE, TOPICS


def _make_pattern(kw: str) -> re.Pattern:
    # Use word boundaries for single-word keywords; phrases match as substring
    # (case-insensitive), since "\b" doesn't play well with multi-word phrases.
    if " " in kw or "-" in kw:
        return re.compile(re.escape(kw), re.IGNORECASE)
    return re.compile(r"\b" + re.escape(kw) + r"\b", re.IGNORECASE)


def _compile() -> tuple[dict, list]:
    topic_patterns = {}
    for key, t in TOPICS.items():
        topic_patterns[key] = {
            "include": [_make_pattern(kw) for kw in t.get("keywords", [])],
            "exclude": [_make_pattern(kw) for kw in t.get("exclude", [])],
        }
    global_excludes = [_make_pattern(kw) for kw in GLOBAL_EXCLUDE]
    return topic_patterns, global_excludes


_TOPIC_PATTERNS, _GLOBAL_EXCLUDES = _compile()


def classify(paper: dict) -> list[str]:
    """Return list of topic keys this paper matches (may be empty or multiple)."""
    haystack = f"{paper.get('title', '')}  {paper.get('abstract', '')}"

    # Global exclude check
    if any(p.search(haystack) for p in _GLOBAL_EXCLUDES):
        return []

    matched = []
    for topic_key, pats in _TOPIC_PATTERNS.items():
        if not any(p.search(haystack) for p in pats["include"]):
            continue
        if any(p.search(haystack) for p in pats["exclude"]):
            continue
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
        # Useful client-side links
        p2["alphaxiv_url"] = f"https://www.alphaxiv.org/abs/{p['id']}"
        out.append(p2)
    return out
