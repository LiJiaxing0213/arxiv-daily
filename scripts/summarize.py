"""Generate concise Chinese summaries via Google Gemini API (or compatible proxy).

Two key/base pairs are supported. Primary is tried first with configurable
concurrency; fallback runs serially at a polite pace (suited for the Google
free tier).

Env vars:
  GEMINI_API_KEY              primary key
  GEMINI_BASE_URL             primary base URL (default: official Google)
  GEMINI_CONCURRENCY          primary parallel workers (default: 5)
  GEMINI_PACE_SECONDS         primary per-call sleep (default: 1.0)
  GEMINI_API_KEY_FALLBACK     fallback key
  GEMINI_FALLBACK_BASE_URL    fallback base URL (default: official Google)
  GEMINI_FALLBACK_CONCURRENCY fallback parallel workers (default: 1)
  GEMINI_FALLBACK_PACE_SECONDS fallback per-call sleep (default: 6.5)
  GEMINI_MODEL                model id (default: gemini-2.5-flash)
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_RETRIES = 3
TIMEOUT = 90

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


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


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


def _summarize_pool(
    papers: list[dict],
    api_key: str,
    base_url: str,
    label: str,
    concurrency: int,
    pace: float,
) -> None:
    """Summarize papers in parallel with `concurrency` workers.

    Each worker waits `pace` seconds between starting requests so we don't
    burst all at once. Aborts the rest if we see many consecutive 429s
    (suggesting daily quota is exhausted).
    """
    if not papers:
        return

    todo = [p for p in papers if not p.get("summary_zh")]
    if not todo:
        return

    print(
        f"[summarize][{label}] {len(todo)} to do, "
        f"concurrency={concurrency} pace={pace}s, base={base_url}",
        flush=True,
    )

    state_lock = threading.Lock()
    pace_lock = threading.Lock()
    last_start = [0.0]
    consecutive_429 = [0]
    done_count = [0]
    bail = threading.Event()

    def worker(idx_paper):
        idx, p = idx_paper
        if bail.is_set():
            return

        # Pace: ensure we don't start a new request within `pace` of the last.
        # This caps the global request rate to ~1/pace per second across all
        # workers, which is what we actually want.
        with pace_lock:
            wait = (last_start[0] + pace) - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            last_start[0] = time.monotonic()

        if bail.is_set():
            return

        try:
            text = _call_gemini(api_key, base_url, p["title"], p["abstract"])
            with state_lock:
                p["summary_zh"] = text
                consecutive_429[0] = 0
                done_count[0] += 1
                if done_count[0] % 10 == 0 or done_count[0] == len(todo):
                    print(
                        f"[summarize][{label}] {done_count[0]}/{len(todo)} done",
                        flush=True,
                    )
        except Exception as e:
            msg = str(e)
            with state_lock:
                done_count[0] += 1
                print(
                    f"[summarize][{label}] FAIL {p['id']}: {msg[:200]}",
                    flush=True,
                )
                if "HTTP 429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
                    consecutive_429[0] += 1
                    if consecutive_429[0] >= max(5, concurrency * 2):
                        print(
                            f"[summarize][{label}] hit quota "
                            f"({consecutive_429[0]} 429s); aborting rest",
                            flush=True,
                        )
                        bail.set()
                else:
                    consecutive_429[0] = 0

    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        list(ex.map(worker, list(enumerate(todo))))


def summarize_papers(papers: list[dict]) -> list[dict]:
    """Mutate each paper in-place adding 'summary_zh'."""
    primary_key  = os.environ.get("GEMINI_API_KEY", "").strip()
    primary_base = os.environ.get("GEMINI_BASE_URL", DEFAULT_BASE).strip()
    primary_concurrency = _env_int("GEMINI_CONCURRENCY", 5)
    primary_pace        = _env_float("GEMINI_PACE_SECONDS", 1.0)

    fb_key  = os.environ.get("GEMINI_API_KEY_FALLBACK", "").strip()
    fb_base = os.environ.get("GEMINI_FALLBACK_BASE_URL", DEFAULT_BASE).strip()
    fb_concurrency = _env_int("GEMINI_FALLBACK_CONCURRENCY", 1)
    fb_pace        = _env_float("GEMINI_FALLBACK_PACE_SECONDS", 6.5)

    if not primary_key and not fb_key:
        print("[summarize] no API key set, skipping summaries", flush=True)
        for p in papers:
            p.setdefault("summary_zh", "")
        return papers

    todo = [p for p in papers if not p.get("summary_zh")]
    print(
        f"[summarize] {len(papers)} papers total, {len(todo)} need summaries via {MODEL}",
        flush=True,
    )

    if primary_key:
        _summarize_pool(todo, primary_key, primary_base, "primary",
                        primary_concurrency, primary_pace)

    leftover = [p for p in todo if not p.get("summary_zh")]
    if leftover and fb_key:
        print(
            f"[summarize] {len(leftover)} left after primary, switching to fallback",
            flush=True,
        )
        _summarize_pool(leftover, fb_key, fb_base, "fallback",
                        fb_concurrency, fb_pace)

    for p in papers:
        p.setdefault("summary_zh", "")
    return papers
