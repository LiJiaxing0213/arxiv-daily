"""Generate concise Chinese summaries via Google Gemini API.

Reads GEMINI_API_KEY from environment. If not set, papers get a placeholder
summary_zh field and the rest of the pipeline still works.

Free tier (gemini-2.5-flash): 10 RPM, 250 RPD — plenty for ~30 papers/day.
"""

from __future__ import annotations

import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_RETRIES = 3
TIMEOUT = 90
# Free tier is 10 RPM => ~6s between requests; we go a bit slower for safety.
PACE_SECONDS = 6.5

def is_truncated(summary: str) -> bool:
    """Heuristic: detect summaries that were cut off mid-sentence.

    Older runs (with thinking-tokens bug) often ended in the middle of a phrase.
    Properly generated Chinese summaries end with terminal punctuation.
    """
    if not summary:
        return True
    s = summary.strip()
    if len(s) < 60:
        return True
    last = s[-1]
    # Chinese / English terminal punctuation, including paired closing chars
    if last in "。！？.!?":
        return False
    if last in "\"'\u201d\u2019）)」』】":
        # If followed by closing quote, also accept if char before is terminal
        if len(s) >= 2 and s[-2] in "。！？.!?":
            return False
    return True


SYSTEM_PROMPT = (
    "你是一位 AI 研究领域的论文速读助手。"
    "你将收到一篇 arXiv 论文的英文标题和摘要，"
    "请用中文输出该论文的完整解读，要求："
    "1) 用 3-4 句话讲清楚：这篇论文要解决什么问题、用了什么方法、关键创新点、实验/结果如何；"
    "2) 总字数控制在 150-250 字，必须是完整的句子，不要在句子中间结束；"
    "3) 保留必要的英文术语（如模型名、benchmark 名、关键技术名）；"
    "4) 不要写「这篇论文」「作者」之类的套话，直接讲内容；"
    "5) 只输出中文摘要正文，不要加任何前缀、标题或 markdown。"
)


def _call_gemini(api_key: str, title: str, abstract: str) -> str:
    user_msg = f"Title: {title}\n\nAbstract: {abstract}"
    url = f"{API_BASE}/{quote(MODEL)}:generateContent?key={quote(api_key)}"
    body = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 1024,
                "responseMimeType": "text/plain",
                # Gemini 2.5 series enables "thinking" tokens by default which
                # silently eat into maxOutputTokens, truncating Chinese output
                # mid-sentence. Disable for this use case.
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
    ).encode("utf-8")

    req = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urlopen(req, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates") or []
            if not candidates:
                # Likely safety-filtered or empty
                pf = data.get("promptFeedback", {})
                raise RuntimeError(f"no candidates (feedback={pf})")
            parts = (candidates[0].get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts).strip()
            if not text:
                raise RuntimeError("empty response text")
            return text
        except HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"HTTP {e.code}: {err_body[:300]}")
            # 429 / 5xx => back off, others => give up
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt * 4)
                continue
            break
        except (URLError, TimeoutError) as e:
            last_err = e
            time.sleep(2 ** attempt * 2)
            continue

    raise last_err if last_err else RuntimeError("unknown gemini error")


def summarize_papers(papers: list[dict]) -> list[dict]:
    """Mutate each paper in-place adding 'summary_zh'. Skips on missing key."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("[summarize] GEMINI_API_KEY not set, skipping summaries", flush=True)
        for p in papers:
            p.setdefault("summary_zh", "")
        return papers

    todo = [p for p in papers if not p.get("summary_zh")]
    print(
        f"[summarize] {len(papers)} papers total, {len(todo)} need summaries via {MODEL}",
        flush=True,
    )

    for i, p in enumerate(todo, 1):
        try:
            p["summary_zh"] = _call_gemini(api_key, p["title"], p["abstract"])
            print(f"[summarize] {i}/{len(todo)} ok: {p['id']}", flush=True)
        except Exception as e:
            print(f"[summarize] {i}/{len(todo)} FAIL {p['id']}: {e}", flush=True)
            p["summary_zh"] = ""
        time.sleep(PACE_SECONDS)

    # Fill defaults for any still missing
    for p in papers:
        p.setdefault("summary_zh", "")
    return papers
