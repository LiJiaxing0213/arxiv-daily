"""Generate concise Chinese summaries via Google Gemini API (or compatible proxy).

Reads two key/base pairs:
  - GEMINI_API_KEY        + GEMINI_BASE_URL          (primary)
  - GEMINI_API_KEY_FALLBACK + GEMINI_FALLBACK_BASE_URL  (used when primary
                                                         hits quota / errors)

If primary key is missing, the rest of the pipeline still works (papers get
empty summary_zh).
"""

from __future__ import annotations

import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_RETRIES = 3
TIMEOUT = 90
PACE_SECONDS = 6.5  # ~9 RPM, under the 10 RPM free-tier limit

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


def is_truncated(summary: str) -> bool:
    """Heuristic: detect summaries that were cut off mid-sentence."""
    if not summary:
        return True
    s = summary.strip()
    if len(s) < 80:
        return True
    last = s[-1]
    if last in "。！？.!?":
        return False
    if last in "\"'\u201d\u2019）)」』】" and len(s) >= 2 and s[-2] in "。！？.!?":
        return False
    return True


def _call_gemini(api_key: str, base_url: str, title: str, abstract: str) -> str:
    user_msg = f"Title: {title}\n\nAbstract: {abstract}"
    url = f"{base_url.rstrip('/')}/models/{quote(MODEL)}:generateContent?key={quote(api_key)}"
    body = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 1024,
                "responseMimeType": "text/plain",
                # Disable Gemini 2.5 "thinking" tokens which silently eat the
                # output budget and truncate Chinese summaries mid-sentence.
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
                pf = data.get("promptFeedback", {})
                raise RuntimeError(f"no candidates (feedback={pf})")
            cand = candidates[0]
            finish_reason = cand.get("finishReason", "?")
            parts = (cand.get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts).strip()
            usage = data.get("usageMetadata", {})
            if not text:
                raise RuntimeError(
                    f"empty response (finishReason={finish_reason}, usage={usage})"
                )
            if finish_reason == "MAX_TOKENS":
                print(
                    f"[summarize]   warning: hit MAX_TOKENS, may be truncated. usage={usage}",
                    flush=True,
                )
            elif finish_reason not in ("STOP",):
                print(
                    f"[summarize]   note: finishReason={finish_reason} usage={usage}",
                    flush=True,
                )
            return text
        except HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"HTTP {e.code}: {err_body[:300]}")
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt * 4)
                continue
            break
        except (URLError, TimeoutError) as e:
            last_err = e
            time.sleep(2 ** attempt * 2)
            continue

    raise last_err if last_err else RuntimeError("unknown gemini error")


def _summarize_with(papers: list[dict], api_key: str, base_url: str, label: str) -> int:
    """Try to summarize papers in-place. Returns the index where we bailed
    (because of quota), or len(papers) if we processed everything.
    """
    consecutive_429 = 0
    for i, p in enumerate(papers):
        if p.get("summary_zh"):
            continue
        try:
            p["summary_zh"] = _call_gemini(api_key, base_url, p["title"], p["abstract"])
            print(f"[summarize][{label}] {i+1}/{len(papers)} ok: {p['id']}", flush=True)
            consecutive_429 = 0
        except Exception as e:
            msg = str(e)
            print(
                f"[summarize][{label}] {i+1}/{len(papers)} FAIL {p['id']}: {msg[:200]}",
                flush=True,
            )
            p["summary_zh"] = ""
            if "HTTP 429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
                consecutive_429 += 1
                if consecutive_429 >= 3:
                    print(
                        f"[summarize][{label}] hit quota (3 consecutive 429s); "
                        f"giving up at index {i}",
                        flush=True,
                    )
                    return i
            else:
                consecutive_429 = 0
        time.sleep(PACE_SECONDS)
    return len(papers)


def summarize_papers(papers: list[dict]) -> list[dict]:
    """Mutate each paper in-place adding 'summary_zh'.

    Tries primary (GEMINI_API_KEY + GEMINI_BASE_URL) first. On quota
    exhaustion, falls back to GEMINI_API_KEY_FALLBACK + GEMINI_FALLBACK_BASE_URL.
    """
    primary_key  = os.environ.get("GEMINI_API_KEY", "").strip()
    primary_base = os.environ.get("GEMINI_BASE_URL", DEFAULT_BASE).strip()
    fb_key  = os.environ.get("GEMINI_API_KEY_FALLBACK", "").strip()
    fb_base = os.environ.get("GEMINI_FALLBACK_BASE_URL", DEFAULT_BASE).strip()

    if not primary_key and not fb_key:
        print("[summarize] no API key set, skipping summaries", flush=True)
        for p in papers:
            p.setdefault("summary_zh", "")
        return papers

    todo = [p for p in papers if not p.get("summary_zh")]
    print(
        f"[summarize] {len(papers)} papers total, {len(todo)} need summaries via "
        f"{MODEL} (primary base: {primary_base or '(unset)'})",
        flush=True,
    )

    if primary_key:
        idx = _summarize_with(todo, primary_key, primary_base, "primary")
    else:
        idx = 0

    # Anything still missing summary_zh after primary -> try fallback
    leftover = [p for p in todo[idx:] if not p.get("summary_zh")] + \
               [p for p in todo[:idx] if not p.get("summary_zh")]
    if leftover and fb_key:
        print(
            f"[summarize] {len(leftover)} papers left after primary, "
            f"switching to fallback ({fb_base})",
            flush=True,
        )
        _summarize_with(leftover, fb_key, fb_base, "fallback")

    for p in papers:
        p.setdefault("summary_zh", "")
    return papers
