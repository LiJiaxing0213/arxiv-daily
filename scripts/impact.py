"""Score papers' likely impact via the NAIP HuggingFace Space.

Paper:  Zhao P, Xing Q, Dou K, et al.
        From Words to Worth: Newborn Article Impact Prediction with LLM.
        arXiv:2408.03934, 2024.
Code:   https://github.com/ssocean/NAIP
Model:  ssocean/NAIP (LLaMA-3-8B fine-tuned with LoRA)
Space:  https://huggingface.co/spaces/ssocean/Newborn_Article_Impact_Predict

We call the public Gradio Space — no GPU needed locally. The Space runs on
ZeroGPU which is rate-limited, so we keep a small per-day budget and fall
back gracefully if it fails.

Adds `impact_score` (float in [0, 1] or None) to each paper.
"""

from __future__ import annotations

import os
import time

try:
    from gradio_client import Client  # type: ignore
    _HAS_GRADIO = True
except ImportError:
    _HAS_GRADIO = False
    Client = None  # type: ignore

SPACE_ID = os.environ.get("NAIP_SPACE_ID", "ssocean/Newborn_Article_Impact_Predict")
MAX_PAPERS_PER_RUN = int(os.environ.get("NAIP_MAX_PAPERS", "50") or 50)
PACE_SECONDS = float(os.environ.get("NAIP_PACE_SECONDS", "3.0") or 3.0)
ABORT_AFTER_FAILS = int(os.environ.get("NAIP_ABORT_AFTER_FAILS", "5") or 5)

_client = None


def _get_client():
    global _client
    if _client is None and _HAS_GRADIO:
        try:
            _client = Client(SPACE_ID)
        except Exception as e:
            print(f"[impact] could not connect to {SPACE_ID}: {e}", flush=True)
            _client = False  # remember failure so we don't keep retrying
    return _client if _client else None


def _score_one(client, title: str, abstract: str):
    """Try a few common Gradio API names since the Space's endpoint isn't documented."""
    candidates = ["/predict", "/Predict", "/run", None]
    last_err = None
    for api in candidates:
        try:
            kwargs = {"api_name": api} if api is not None else {}
            res = client.predict(title, abstract, **kwargs)
            return res
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError("unknown api_name")


def _to_score(raw):
    """Coerce the Gradio response (str / float / dict) to a float in [0, 1]."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return max(0.0, min(1.0, float(raw)))
    if isinstance(raw, dict):
        # Some Spaces return {"label": "...", "confidences": [...]}
        for k in ("score", "confidence", "value", "impact"):
            if k in raw:
                return _to_score(raw[k])
        return None
    if isinstance(raw, str):
        # Try to extract a float from the string
        import re
        m = re.search(r"([01](?:\.\d+)?|0?\.\d+)", raw)
        if m:
            try:
                return max(0.0, min(1.0, float(m.group(1))))
            except ValueError:
                return None
    return None


def score_papers(papers: list) -> None:
    """Mutate papers in-place adding 'impact_score' (float in [0,1] or None).

    Skips papers that already have a score. Hard-caps the number of API calls
    per run at MAX_PAPERS_PER_RUN. Aborts on consecutive failures.
    """
    if not _HAS_GRADIO:
        print(
            "[impact] `gradio_client` not installed — skipping impact scoring. "
            "Add `gradio_client` to requirements.txt to enable.",
            flush=True,
        )
        for p in papers:
            p.setdefault("impact_score", None)
        return

    client = _get_client()
    if not client:
        print("[impact] no Gradio client — skipping impact scoring", flush=True)
        for p in papers:
            p.setdefault("impact_score", None)
        return

    todo = [p for p in papers if p.get("impact_score") is None]
    if not todo:
        print("[impact] nothing to score (all cached)", flush=True)
        return

    if len(todo) > MAX_PAPERS_PER_RUN:
        print(
            f"[impact] {len(todo)} papers need scoring but capped at "
            f"{MAX_PAPERS_PER_RUN}; remainder will get scored on next run.",
            flush=True,
        )
        todo = todo[:MAX_PAPERS_PER_RUN]

    print(f"[impact] scoring {len(todo)} papers via {SPACE_ID}", flush=True)

    consecutive_fail = 0
    scored = 0
    for i, p in enumerate(todo, 1):
        title = (p.get("title") or "").strip()
        abstract = (p.get("abstract") or "").strip()
        if not title or not abstract:
            p["impact_score"] = None
            continue
        try:
            raw = _score_one(client, title, abstract)
            score = _to_score(raw)
            p["impact_score"] = score
            consecutive_fail = 0
            scored += 1
            print(f"[impact] {i}/{len(todo)} ok: {p['id']} -> {score}", flush=True)
        except Exception as e:
            consecutive_fail += 1
            err = str(e)[:160]
            print(f"[impact] {i}/{len(todo)} FAIL {p.get('id')}: {err}", flush=True)
            p["impact_score"] = None
            if consecutive_fail >= ABORT_AFTER_FAILS:
                print(f"[impact] {ABORT_AFTER_FAILS} consecutive failures; aborting", flush=True)
                break
        time.sleep(PACE_SECONDS)

    print(f"[impact] scored {scored}/{len(todo)} this run", flush=True)
