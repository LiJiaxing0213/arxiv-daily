"""Fetch recent papers from arXiv API for configured categories."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from config import ARXIV_CATEGORIES, LOOKBACK_DAYS, MAX_RESULTS_PER_CATEGORY

ARXIV_API = "http://export.arxiv.org/api/query"
NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _parse_entry(entry: ET.Element) -> dict:
    def text(tag: str) -> str:
        el = entry.find(f"atom:{tag}", NS)
        return (el.text or "").strip() if el is not None else ""

    arxiv_id_full = text("id")  # e.g. http://arxiv.org/abs/2501.01234v1
    arxiv_id = arxiv_id_full.rsplit("/", 1)[-1]
    arxiv_id_clean = arxiv_id.split("v")[0]

    authors = [
        (a.find("atom:name", NS).text or "").strip()
        for a in entry.findall("atom:author", NS)
        if a.find("atom:name", NS) is not None
    ]

    categories = [
        c.attrib.get("term", "")
        for c in entry.findall("atom:category", NS)
        if c.attrib.get("term")
    ]

    pdf_link = ""
    for link in entry.findall("atom:link", NS):
        if link.attrib.get("title") == "pdf":
            pdf_link = link.attrib.get("href", "")
            break

    return {
        "id": arxiv_id_clean,
        "title": " ".join(text("title").split()),
        "abstract": " ".join(text("summary").split()),
        "authors": authors,
        "categories": categories,
        "published": text("published"),
        "updated": text("updated"),
        "pdf_url": pdf_link or f"https://arxiv.org/pdf/{arxiv_id_clean}",
        "abs_url": f"https://arxiv.org/abs/{arxiv_id_clean}",
    }


def _query(category: str, max_results: int) -> list[dict]:
    params = {
        "search_query": f"cat:{category}",
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    url = f"{ARXIV_API}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": "arxiv-daily/0.1 (+github actions)"})
    with urlopen(req, timeout=60) as resp:
        data = resp.read()

    root = ET.fromstring(data)
    return [_parse_entry(e) for e in root.findall("atom:entry", NS)]


def fetch_recent(
    categories: Iterable[str] = ARXIV_CATEGORIES,
    lookback_days: int = LOOKBACK_DAYS,
    max_per_cat: int = MAX_RESULTS_PER_CATEGORY,
) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    seen: dict[str, dict] = {}

    for cat in categories:
        print(f"[fetch] querying {cat} ...", flush=True)
        try:
            entries = _query(cat, max_per_cat)
        except Exception as e:
            print(f"[fetch]   error on {cat}: {e}", flush=True)
            continue

        kept = 0
        for p in entries:
            try:
                pub_dt = datetime.fromisoformat(p["published"].replace("Z", "+00:00"))
            except ValueError:
                continue
            if pub_dt < cutoff:
                continue
            if p["id"] not in seen:
                seen[p["id"]] = p
                kept += 1
        print(f"[fetch]   kept {kept} new from {cat}", flush=True)

        # arxiv asks for >= 3 sec between requests
        time.sleep(3.5)

    papers = list(seen.values())
    papers.sort(key=lambda p: p["published"], reverse=True)
    print(f"[fetch] total unique papers: {len(papers)}", flush=True)
    return papers


if __name__ == "__main__":
    import json, sys
    papers = fetch_recent()
    json.dump(papers, sys.stdout, ensure_ascii=False, indent=2)
