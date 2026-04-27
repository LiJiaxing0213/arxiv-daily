"""LLM-based relevance filter for arxiv papers.

Reuses the same Gemini client config as summarize.py:
  GEMINI_API_KEY + GEMINI_BASE_URL  (primary)
  GEMINI_API_KEY_FALLBACK + GEMINI_FALLBACK_BASE_URL  (used on quota / errors)

For each paper, asks the model to answer Yes/No based on `paper_to_hunt.md`.
Marks each paper with `_passed_llm: bool`. Conservative: errors keep paper.
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
TIMEOUT = 60
MAX_RETRIES = 2

ROOT = Path(__file__).resolve().parent.parent
HUNT_FILE = ROOT / "paper_to_hunt.md"

DEFAULT_HUNT = """
我关心以下方向的论文(应保留):
- 世界模型 / world models / world simulators / 视频世界模型 / dynamics models
- 强化学习理论与算法 (PPO, TRPO, DPO, GRPO, IPO, KTO, Q-learning, actor-critic, policy gradient, offline RL, model-based RL)
- 扩散 / 流匹配模型的 RL / 偏好对齐微调 (DDPO, DPOK, RL fine-tuning of diffusion, RLHF / RLAIF for generative models, reward-weighted diffusion)
- 模型蒸馏 (knowledge distillation, consistency models, step distillation, score distillation, speculative decoding, LLM distillation)
- 视频生成 (video diffusion, text-to-video, image-to-video, controllable video generation, long video, video DiT)
- 4D 生成 (4D Gaussian splatting, dynamic 3D scene, deformable Gaussian, dynamic NeRF)

应过滤掉(即使关键词命中):
- 量子电路、量子计算、量子机器学习
- 把 RL 用作纯应用工具的论文(机器人导航/电网调度/股票交易/无线通信/交通信号)
- 单纯的视频分类、视频检索、视频问答(没有生成成分)
- 数据集蒸馏(dataset distillation,与模型蒸馏不同)
- 与上述主题只有表面关键词重合、实际研究内容无关的论文
"""


def _load_hunt() -> str:
    if HUNT_FILE.exists():
        try:
            return HUNT_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            pass
    return DEFAULT_HUNT.strip()


PROMPT_TEMPLATE = (
    "你是一个学术论文筛选助手。请判断这篇论文是否与下述研究方向高度相关。\n\n"
    "{hunt}\n\n"
    "---\n"
    "论文标题: {title}\n"
    "论文摘要: {abstract}\n"
    "---\n\n"
    "如果与上述方向相关,只输出 Yes;否则只输出 No。不要解释,不要任何其他内容。"
)


def _call_gemini(api_key: str, base_url: str, prompt: str) -> str:
    url = f"{base_url.rstrip('/')}/models/{quote(MODEL)}:generateContent?key={quote(api_key)}"
    body = json.dumps(
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 16,
                "responseMimeType": "text/plain",
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
    ).encode("utf-8")
    req = Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urlopen(req, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            cand = (data.get("candidates") or [{}])[0]
            parts = (cand.get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts).strip()
            return text
        except HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"HTTP {e.code}: {err_body[:200]}")
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt * 3)
                continue
            break
        except (URLError, TimeoutError) as e:
            last_err = e
            time.sleep(2 ** attempt * 2)

    raise last_err or RuntimeError("unknown")


def _yes_no(text: str) -> bool:
    """Parse yes/no from LLM response. Default True on ambiguity (conservative)."""
    if not text:
        return True
    low = text.strip().lower()
    if low.startswith("no") or low == "n":
        return False
    if low.startswith("yes") or low == "y":
        return True
    # Ambiguous response → keep paper (don't accidentally drop)
    return True


def _filter_with(papers: list, api_key: str, base_url: str, label: str,
                 concurrency: int, pace: float, hunt: str) -> int:
    """Run LLM filter on papers without _passed_llm yet. Returns # processed before bail."""
    todo = [p for p in papers if "_passed_llm" not in p]
    if not todo:
        return 0

    print(
        f"[llm_filter][{label}] {len(todo)} papers to check, "
        f"concurrency={concurrency} pace={pace}s, base={base_url}",
        flush=True,
    )

    pace_lock = threading.Lock()
    last_start = [0.0]
    consecutive_429 = [0]
    bail = threading.Event()
    done = [0]
    state_lock = threading.Lock()

    def worker(p):
        if bail.is_set():
            return
        with pace_lock:
            wait = (last_start[0] + pace) - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            last_start[0] = time.monotonic()
        if bail.is_set():
            return

        prompt = PROMPT_TEMPLATE.format(
            hunt=hunt,
            title=(p.get("title") or "")[:300],
            abstract=(p.get("abstract") or "")[:1500],
        )
        try:
            ans = _call_gemini(api_key, base_url, prompt)
            with state_lock:
                p["_passed_llm"] = _yes_no(ans)
                consecutive_429[0] = 0
                done[0] += 1
                if done[0] % 20 == 0:
                    print(f"[llm_filter][{label}] {done[0]}/{len(todo)} done", flush=True)
        except Exception as e:
            msg = str(e)
            with state_lock:
                done[0] += 1
                if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
                    consecutive_429[0] += 1
                    if consecutive_429[0] >= max(5, concurrency * 2):
                        print(f"[llm_filter][{label}] hit quota; aborting", flush=True)
                        bail.set()
                else:
                    consecutive_429[0] = 0
                # Conservative: missing answer keeps paper

    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        list(ex.map(worker, todo))


def filter_papers(papers: list) -> None:
    """Mutate papers in-place, adding '_passed_llm' boolean to each.

    Papers with `_passed_llm` already set (from cached previous runs) are kept.
    Falls back to second key/base on quota exhaustion.
    """
    primary_key  = os.environ.get("GEMINI_API_KEY", "").strip()
    primary_base = os.environ.get("GEMINI_BASE_URL", DEFAULT_BASE).strip()
    primary_concurrency = int(os.environ.get("GEMINI_CONCURRENCY", "5") or 5)
    primary_pace        = float(os.environ.get("GEMINI_PACE_SECONDS", "1.0") or 1.0)

    fb_key  = os.environ.get("GEMINI_API_KEY_FALLBACK", "").strip()
    fb_base = os.environ.get("GEMINI_FALLBACK_BASE_URL", DEFAULT_BASE).strip()
    fb_concurrency = int(os.environ.get("GEMINI_FALLBACK_CONCURRENCY", "1") or 1)
    fb_pace        = float(os.environ.get("GEMINI_FALLBACK_PACE_SECONDS", "6.5") or 6.5)

    if not primary_key and not fb_key:
        print("[llm_filter] no API key set, marking all papers as passed", flush=True)
        for p in papers:
            p.setdefault("_passed_llm", True)
        return

    hunt = _load_hunt()

    if primary_key:
        _filter_with(papers, primary_key, primary_base, "primary", primary_concurrency, primary_pace, hunt)
    if fb_key:
        _filter_with(papers, fb_key, fb_base, "fallback", fb_concurrency, fb_pace, hunt)

    # Anything still without a verdict (both stages bailed) → conservative keep
    unmarked = 0
    for p in papers:
        if "_passed_llm" not in p:
            p["_passed_llm"] = True
            unmarked += 1
    if unmarked:
        print(f"[llm_filter] {unmarked} papers unmarked (kept conservatively)", flush=True)

    passed = sum(1 for p in papers if p.get("_passed_llm"))
    print(f"[llm_filter] passed: {passed}/{len(papers)}", flush=True)
