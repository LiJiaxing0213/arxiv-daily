"""Pipeline entrypoint: fetch -> classify -> summarize -> per-date JSON files.

Generates one file per published date for the last RETENTION_DAYS days.
Older files are deleted. Reuses cached summaries to save API calls.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from classify import filter_and_tag
from config import RETENTION_DAYS, TOPICS
from fetch import fetch_recent
from summarize import is_truncated, summarize_papers

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def _load_all_cached(retention_dates: set[str]) -> dict[str, dict]:
    """Load all summaries we already have, indexed by paper id."""
    by_id: dict[str, dict] = {}
    if not DATA_DIR.exists():
        return by_id
    for path in DATA_DIR.glob("*.json"):
        if path.name == "index.json":
            continue
        try:
            with path.open("r", encoding="utf-8") as f:
                blob = json.load(f)
            for p in blob.get("papers", []):
                if p.get("id") and p.get("summary_zh"):
                    by_id[p["id"]] = p
        except (json.JSONDecodeError, OSError):
            continue
    return by_id


def _group_by_date(papers: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for p in papers:
        published = p.get("published", "")
        date_key = published[:10] if len(published) >= 10 else "unknown"
        out.setdefault(date_key, []).append(p)
    return out


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    today = datetime.now(timezone.utc).date()
    retention_dates = {
        (today - timedelta(days=i)).strftime("%Y-%m-%d")
        for i in range(RETENTION_DAYS)
    }
    print(f"[main] retention window: {sorted(retention_dates)}", flush=True)

    cached = _load_all_cached(retention_dates)
    print(f"[main] {len(cached)} papers cached from previous runs", flush=True)

    raw = fetch_recent()
    print(f"[main] fetched {len(raw)} raw papers across all categories", flush=True)
    tagged = filter_and_tag(raw)
    print(f"[main] {len(tagged)} papers matched topics (across all dates)", flush=True)

    # Show per-date breakdown of what we fetched (helps diagnose backfill issues)
    pre_grouped: dict[str, int] = {}
    for p in tagged:
        d = (p.get("published") or "")[:10]
        pre_grouped[d] = pre_grouped.get(d, 0) + 1
    for d in sorted(pre_grouped, reverse=True):
        print(f"[main]   {d}: {pre_grouped[d]} papers (matched)", flush=True)

    # Reuse cached summaries — but skip truncated ones from older buggy runs
    regen = 0
    for p in tagged:
        prev = cached.get(p["id"])
        if prev and prev.get("summary_zh"):
            if is_truncated(prev["summary_zh"]):
                regen += 1  # leave summary_zh empty -> will be regenerated
            else:
                p["summary_zh"] = prev["summary_zh"]
    if regen:
        print(f"[main] flagged {regen} cached summaries as truncated, will regenerate", flush=True)

    # Group by published date and only keep dates within retention window
    by_date = _group_by_date(tagged)
    by_date = {d: ps for d, ps in by_date.items() if d in retention_dates}

    # Sort within each date by published time desc for stable display
    for d in by_date:
        by_date[d].sort(key=lambda p: p.get("published", ""), reverse=True)

    # Summarize papers across all dates that don't yet have summary_zh
    needs_summary: list[dict] = []
    for ps in by_date.values():
        for p in ps:
            if not p.get("summary_zh"):
                needs_summary.append(p)
    summarize_papers(needs_summary)

    # Write one JSON per date in the retention window (always write all
    # dates, even with 0 papers, so the UI dropdown shows the day).
    topics_meta = {k: {"name_zh": v["name_zh"], "name_en": v["name_en"]} for k, v in TOPICS.items()}
    written_dates: list[str] = []
    for date in sorted(retention_dates, reverse=True):
        papers = by_date.get(date, [])
        for p in papers:
            p.setdefault("summary_zh", "")
        payload = {
            "date": date,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "topics": topics_meta,
            "papers": papers,
        }
        path = DATA_DIR / f"{date}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        marker = "" if papers else "  (empty placeholder)"
        print(f"[main] wrote {path.name} ({len(papers)} papers){marker}", flush=True)
        written_dates.append(date)

    # Delete files outside retention window
    for path in DATA_DIR.glob("*.json"):
        if path.name == "index.json":
            continue
        date = path.stem
        if date not in retention_dates:
            try:
                path.unlink()
                print(f"[main] deleted stale {path.name}", flush=True)
            except OSError:
                pass

    # Rebuild index.json
    dates = sorted(
        [p.stem for p in DATA_DIR.glob("*.json") if p.name != "index.json"],
        reverse=True,
    )
    counts = {}
    for d in dates:
        try:
            with (DATA_DIR / f"{d}.json").open("r", encoding="utf-8") as f:
                counts[d] = len(json.load(f).get("papers", []))
        except Exception:
            counts[d] = 0

    index = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "dates": dates,
        "counts": counts,
        "topics": topics_meta,
    }
    with (DATA_DIR / "index.json").open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"[main] index has {len(dates)} dates", flush=True)


if __name__ == "__main__":
    main()
