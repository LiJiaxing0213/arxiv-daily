"""Pipeline entrypoint: fetch -> classify -> summarize -> write data files."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from classify import filter_and_tag
from config import TOPICS
from fetch import fetch_recent
from summarize import summarize_papers

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def _load_existing(path: Path) -> dict[str, dict]:
    """Load already-summarized papers indexed by id (for incremental updates)."""
    by_id: dict[str, dict] = {}
    if not path.exists():
        return by_id
    try:
        with path.open("r", encoding="utf-8") as f:
            blob = json.load(f)
        for p in blob.get("papers", []):
            by_id[p["id"]] = p
    except (json.JSONDecodeError, OSError):
        pass
    return by_id


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_path = DATA_DIR / f"{today}.json"
    existing = _load_existing(today_path)
    print(f"[main] {len(existing)} papers already cached for {today}", flush=True)

    raw = fetch_recent()
    tagged = filter_and_tag(raw)
    print(f"[main] {len(tagged)} papers matched topics", flush=True)

    # Reuse summaries from previous runs to save API calls
    for p in tagged:
        prev = existing.get(p["id"])
        if prev and prev.get("summary_zh"):
            p["summary_zh"] = prev["summary_zh"]

    # Only summarize ones we don't already have
    summarize_papers(tagged)

    # Write today's data
    payload = {
        "date": today,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "topics": {k: {"name_zh": v["name_zh"], "name_en": v["name_en"]} for k, v in TOPICS.items()},
        "papers": tagged,
    }
    with today_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[main] wrote {today_path} ({len(tagged)} papers)", flush=True)

    # Rebuild index.json: list of all available dates
    dates = sorted(
        [p.stem for p in DATA_DIR.glob("*.json") if p.name != "index.json"],
        reverse=True,
    )
    index = {"updated_at": datetime.now(timezone.utc).isoformat(), "dates": dates}
    with (DATA_DIR / "index.json").open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"[main] index has {len(dates)} dates", flush=True)


if __name__ == "__main__":
    main()
