// arxiv-daily front-end. Reads ./data/index.json then ./data/<date>.json.

const $ = (sel) => document.querySelector(sel);
const STAR_KEY = "arxiv-daily-stars";

const state = {
  dates: [],
  date: null,
  data: null,         // { date, topics, papers: [...] }
  topic: "all",       // "all" | "starred" | topic key
  query: "",
  stars: new Set(JSON.parse(localStorage.getItem(STAR_KEY) || "[]")),
};

function saveStars() {
  localStorage.setItem(STAR_KEY, JSON.stringify([...state.stars]));
}

async function loadIndex() {
  const r = await fetch("./data/index.json", { cache: "no-store" });
  if (!r.ok) throw new Error("index.json not found — 还没生成数据");
  return r.json();
}

async function loadDate(date) {
  const r = await fetch(`./data/${date}.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`无法加载 ${date}.json`);
  return r.json();
}

function setStatus(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.style.color = isError ? "var(--accent)" : "var(--fg-soft)";
}

function buildTopicTabs() {
  const nav = $("#topic-tabs");
  nav.innerHTML = "";

  const counts = { all: state.data.papers.length, starred: 0 };
  for (const p of state.data.papers) {
    if (state.stars.has(p.id)) counts.starred += 1;
    for (const t of p.topics || []) counts[t] = (counts[t] || 0) + 1;
  }

  const tabs = [
    ["all", "全部"],
    ...Object.entries(state.data.topics).map(([k, v]) => [k, v.name_zh]),
    ["starred", "★ 收藏"],
  ];

  for (const [key, label] of tabs) {
    const b = document.createElement("button");
    b.textContent = label;
    const cnt = counts[key] || 0;
    const cspan = document.createElement("span");
    cspan.className = "count";
    cspan.textContent = cnt;
    b.appendChild(cspan);
    if (key === state.topic) b.classList.add("active");
    b.onclick = () => {
      state.topic = key;
      buildTopicTabs();
      renderList();
    };
    nav.appendChild(b);
  }
}

function buildDateSelect() {
  const sel = $("#date-select");
  sel.innerHTML = "";
  for (const d of state.dates) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    if (d === state.date) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    state.date = sel.value;
    await reloadDate();
  };
}

function paperMatches(p) {
  if (state.topic === "starred") {
    if (!state.stars.has(p.id)) return false;
  } else if (state.topic !== "all") {
    if (!(p.topics || []).includes(state.topic)) return false;
  }
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  if (p.title.toLowerCase().includes(q)) return true;
  if (p.abstract.toLowerCase().includes(q)) return true;
  if ((p.summary_zh || "").toLowerCase().includes(q)) return true;
  if (p.authors.some((a) => a.toLowerCase().includes(q))) return true;
  return false;
}

function fmtAuthors(authors) {
  if (!authors || !authors.length) return "";
  if (authors.length <= 4) return authors.join(", ");
  return authors.slice(0, 4).join(", ") + ` 等 ${authors.length} 人`;
}

function renderPaper(p) {
  const art = document.createElement("article");
  art.className = "paper";

  const topicLabels = (p.topics || [])
    .map((k) => state.data.topics[k]?.name_zh || k)
    .map((n) => `<span class="tag">${n}</span>`)
    .join("");

  const starred = state.stars.has(p.id);
  const summaryZh = p.summary_zh
    ? `<div class="summary-zh">${escapeHtml(p.summary_zh)}</div>`
    : `<div class="summary-zh empty">（中文摘要未生成）</div>`;

  art.innerHTML = `
    <h2><a href="${p.abs_url}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></h2>
    <div class="authors">${escapeHtml(fmtAuthors(p.authors))} · ${p.published.slice(0, 10)}</div>
    ${summaryZh}
    <details class="abstract"><summary>原文摘要</summary><p>${escapeHtml(p.abstract)}</p></details>
    <div class="row">
      <div class="tags">${topicLabels}</div>
      <div class="links">
        <button class="star ${starred ? "on" : ""}" title="收藏">${starred ? "★" : "☆"}</button>
        <a href="${p.abs_url}" target="_blank" rel="noopener">abs</a>
        <a href="${p.pdf_url}" target="_blank" rel="noopener">pdf</a>
      </div>
    </div>`;

  art.querySelector(".star").onclick = () => {
    if (state.stars.has(p.id)) state.stars.delete(p.id);
    else state.stars.add(p.id);
    saveStars();
    renderList();
    buildTopicTabs();
  };
  return art;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderList() {
  const list = $("#paper-list");
  list.innerHTML = "";
  const filtered = state.data.papers.filter(paperMatches);
  if (!filtered.length) {
    list.innerHTML = `<p style="color:var(--fg-soft)">没有匹配的论文。</p>`;
    return;
  }
  for (const p of filtered) list.appendChild(renderPaper(p));
}

async function reloadDate() {
  setStatus(`加载 ${state.date} …`);
  try {
    state.data = await loadDate(state.date);
    setStatus(`${state.date} · 共 ${state.data.papers.length} 篇`);
    buildTopicTabs();
    renderList();
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function main() {
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    renderList();
  });

  try {
    const idx = await loadIndex();
    state.dates = idx.dates || [];
    if (!state.dates.length) {
      setStatus("还没有任何数据。等 GitHub Actions 第一次跑完后再刷新。", true);
      return;
    }
    state.date = state.dates[0];
    buildDateSelect();
    await reloadDate();
  } catch (e) {
    setStatus(e.message + "（可能 Actions 还没首次运行）", true);
  }
}

main();
