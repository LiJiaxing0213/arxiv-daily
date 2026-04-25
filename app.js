// arxiv-daily front-end. Three views: daily / mine / trash.
// "我的" supports per-topic subcategories with drag-drop reordering.
// Optional cross-device sync via GitHub Gist.

const $ = (sel) => document.querySelector(sel);

const LS = {
  saved:   "arxiv-daily-saved-v2",   // {[id]: paper}
  trash:   "arxiv-daily-trash-v2",   // {[id]: paper}
  layout:  "arxiv-daily-layout-v1",  // {topicOrder, subcats, paperOrder}
  sync:    "arxiv-daily-sync-v1",    // {token, gistId, lastSyncedAt}
  legacy:  "arxiv-daily-stars",      // legacy stars (array of ids)
};

const DEFAULT_TOPICS = ["world-model", "rl", "distillation", "video-gen", "4d-gen", "other"];

const TOPIC_FALLBACK = {
  "world-model": { name_zh: "世界模型" },
  "rl":          { name_zh: "强化学习" },
  "distillation":{ name_zh: "模型蒸馏" },
  "video-gen":   { name_zh: "视频生成" },
  "4d-gen":      { name_zh: "4D 生成" },
  "other":       { name_zh: "其他" },
};

const state = {
  view: "daily",
  index: null,
  date: null,
  data: null,
  topic: "all",
  query: "",
  saved:  loadJson(LS.saved,  {}),
  trash:  loadJson(LS.trash,  {}),
  layout: loadJson(LS.layout, null),
  sync:   loadJson(LS.sync,   {}),
  syncStatus: "idle", // idle | syncing | synced | error | disabled
  syncTimer: null,
};

// ---------- localStorage ----------

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}
function saveJson(key, val) {
  if (val === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(val));
}

function persistAll() {
  saveJson(LS.saved,  state.saved);
  saveJson(LS.trash,  state.trash);
  saveJson(LS.layout, state.layout);
  scheduleSync();
}

// ---------- layout init / migration ----------

function freshLayout() {
  const subcats = {};
  const paperOrder = {};
  for (const t of DEFAULT_TOPICS) {
    subcats[t] = ["general"];
    paperOrder[`${t}:general`] = [];
  }
  return { topicOrder: [...DEFAULT_TOPICS], subcats, paperOrder };
}

function ensureLayout() {
  if (!state.layout) state.layout = freshLayout();
  // Make sure every default topic exists
  for (const t of DEFAULT_TOPICS) {
    if (!state.layout.subcats[t]) state.layout.subcats[t] = ["general"];
    if (!state.layout.topicOrder.includes(t)) state.layout.topicOrder.push(t);
    const key = `${t}:general`;
    if (!state.layout.paperOrder[key]) state.layout.paperOrder[key] = [];
  }
}

function migrateLegacyStars() {
  const legacy = JSON.parse(localStorage.getItem(LS.legacy) || "null");
  if (Array.isArray(legacy) && legacy.length && Object.keys(state.saved).length === 0) {
    for (const id of legacy) {
      state.saved[id] = {
        id,
        title: `(已收藏: ${id})`,
        authors: [],
        abstract: "",
        summary_zh: "",
        topics: [],
        published: "",
        abs_url: `https://arxiv.org/abs/${id}`,
        pdf_url: `https://arxiv.org/pdf/${id}`,
        alphaxiv_url: `https://www.alphaxiv.org/abs/${id}`,
        added_at: new Date().toISOString(),
        source: "legacy",
        notes: "",
      };
    }
    localStorage.removeItem(LS.legacy);
  }
}

function placePaperInLayout(paperId, topic, subcat = "general") {
  ensureLayout();
  if (!DEFAULT_TOPICS.includes(topic) && !state.layout.subcats[topic]) {
    state.layout.subcats[topic] = ["general"];
    if (!state.layout.topicOrder.includes(topic)) state.layout.topicOrder.push(topic);
  }
  if (!state.layout.subcats[topic].includes(subcat)) {
    state.layout.subcats[topic].push(subcat);
  }
  const key = `${topic}:${subcat}`;
  if (!state.layout.paperOrder[key]) state.layout.paperOrder[key] = [];
  // Remove from any other location first
  removePaperFromLayout(paperId);
  // Add to head (newly added papers go on top)
  state.layout.paperOrder[key].unshift(paperId);
}

function removePaperFromLayout(paperId) {
  if (!state.layout) return;
  for (const k of Object.keys(state.layout.paperOrder)) {
    state.layout.paperOrder[k] = state.layout.paperOrder[k].filter(id => id !== paperId);
  }
}

function findPaperLocation(paperId) {
  if (!state.layout) return null;
  for (const [key, ids] of Object.entries(state.layout.paperOrder)) {
    if (ids.includes(paperId)) {
      const [topic, subcat] = key.split(":", 2);
      // Note: split with limit 2 in JS still gives all; use indexOf workaround
      const i = key.indexOf(":");
      return { topic: key.slice(0, i), subcat: key.slice(i + 1) };
    }
  }
  return null;
}

// Place any saved paper that's not yet in layout into its default slot
function reconcileLayout() {
  ensureLayout();
  for (const [id, p] of Object.entries(state.saved)) {
    if (findPaperLocation(id)) continue;
    let topic = (p.topics && p.topics[0]) || "other";
    if (!DEFAULT_TOPICS.includes(topic)) topic = "other";
    placePaperInLayout(id, topic, "general");
  }
  // Remove orphan ids from layout (saved was deleted somehow)
  for (const k of Object.keys(state.layout.paperOrder)) {
    state.layout.paperOrder[k] = state.layout.paperOrder[k].filter(id => state.saved[id]);
  }
}

migrateLegacyStars();
ensureLayout();
reconcileLayout();
saveJson(LS.layout, state.layout);
saveJson(LS.saved,  state.saved);

// ---------- helpers ----------

function topicMeta(key) {
  return state.index?.topics?.[key] || TOPIC_FALLBACK[key] || { name_zh: key };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtAuthors(authors) {
  if (!authors || !authors.length) return "";
  if (authors.length <= 4) return authors.join(", ");
  return authors.slice(0, 4).join(", ") + ` 等 ${authors.length} 人`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function setStatus(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

// ---------- data loading (daily) ----------

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

async function reloadDate() {
  setStatus(`加载 ${state.date} …`);
  try {
    state.data = await loadDate(state.date);
    setStatus(`${state.date} · 共 ${state.data.papers.length} 篇`);
    if (state.view === "daily") {
      state.topic = "all";
      renderTopicTabs();
      renderList();
    }
  } catch (e) {
    setStatus(e.message, true);
  }
}

function buildDateSelect() {
  const sel = $("#date-select");
  sel.innerHTML = "";
  for (const d of state.index.dates) {
    const o = document.createElement("option");
    o.value = d;
    const cnt = state.index.counts?.[d] ?? "?";
    o.textContent = `${d} (${cnt})`;
    if (d === state.date) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    state.date = sel.value;
    await reloadDate();
  };
}

// ---------- view switching ----------

function setView(view) {
  state.view = view;
  state.topic = view === "mine" ? state.layout.topicOrder[0] : "all";
  for (const b of document.querySelectorAll("#view-switch button")) {
    b.classList.toggle("active", b.dataset.view === view);
  }
  $("#date-select").style.display = view === "daily" ? "" : "none";
  $("#upload-bar").hidden = view !== "mine";
  renderTopicTabs();
  renderList();
}

// ---------- topic tabs ----------

function topicCounts(papers) {
  const counts = { all: papers.length };
  for (const p of papers) {
    for (const t of (p.topics || [])) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function topicCountsForMine() {
  // Counts based on layout (each paper lives in one topic in mine)
  const counts = {};
  for (const t of state.layout.topicOrder) {
    let n = 0;
    for (const sc of state.layout.subcats[t] || []) {
      n += (state.layout.paperOrder[`${t}:${sc}`] || []).length;
    }
    counts[t] = n;
  }
  return counts;
}

function renderTopicTabs() {
  const nav = $("#topic-tabs");
  nav.innerHTML = "";
  if (state.view === "trash") return;

  let tabs;
  let counts;

  if (state.view === "mine") {
    tabs = state.layout.topicOrder.map(t => [t, topicMeta(t).name_zh]);
    counts = topicCountsForMine();
  } else {
    const papers = (state.data?.papers || []).filter(p => !state.trash[p.id]);
    counts = topicCounts(papers);
    counts.all = papers.length;
    const topicsObj = state.index?.topics || TOPIC_FALLBACK;
    tabs = [
      ["all", "全部"],
      ...Object.entries(topicsObj).map(([k, v]) => [k, v.name_zh]),
    ];
  }

  for (const [key, label] of tabs) {
    const b = document.createElement("button");
    b.dataset.topic = key;
    b.textContent = label;
    const cnt = counts[key] || 0;
    const cspan = document.createElement("span");
    cspan.className = "count";
    cspan.textContent = cnt;
    b.appendChild(cspan);
    if (key === state.topic) b.classList.add("active");
    if (state.view === "mine") b.classList.add("draggable");
    b.onclick = () => {
      state.topic = key;
      // Re-render only what's needed
      for (const x of nav.querySelectorAll("button")) {
        x.classList.toggle("active", x.dataset.topic === key);
      }
      renderList();
    };
    nav.appendChild(b);
  }

  // Sortable for topic tabs in "我的"
  if (state.view === "mine") {
    Sortable.create(nav, {
      animation: 150,
      filter: ":not(.draggable)",
      onEnd: () => {
        const newOrder = [...nav.querySelectorAll("button")].map(b => b.dataset.topic);
        state.layout.topicOrder = newOrder;
        persistAll();
      },
    });
  }
}

// ---------- list rendering ----------

function renderList() {
  const list = $("#paper-list");
  list.innerHTML = "";

  if (state.view === "mine") {
    renderMine(list);
  } else if (state.view === "trash") {
    renderFlatList(list, Object.values(state.trash));
  } else {
    let papers = (state.data?.papers || []).filter(p => !state.trash[p.id]);
    if (state.topic !== "all") {
      papers = papers.filter(p => (p.topics || []).includes(state.topic));
    }
    renderFlatList(list, papers);
  }
}

function paperMatchesQuery(p) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  if ((p.title || "").toLowerCase().includes(q)) return true;
  if ((p.abstract || "").toLowerCase().includes(q)) return true;
  if ((p.summary_zh || "").toLowerCase().includes(q)) return true;
  if ((p.notes || "").toLowerCase().includes(q)) return true;
  if ((p.authors || []).some(a => a.toLowerCase().includes(q))) return true;
  return false;
}

function renderFlatList(list, papers) {
  papers = papers.filter(paperMatchesQuery);
  papers.sort((a, b) => {
    const ka = a.published || a.added_at || "";
    const kb = b.published || b.added_at || "";
    return kb.localeCompare(ka);
  });
  if (!papers.length) {
    list.innerHTML = `<p class="muted">${
      state.view === "trash" ? "回收站是空的。" : "没有匹配的论文。"
    }</p>`;
    return;
  }
  for (const p of papers) list.appendChild(renderPaper(p));
}

function renderMine(list) {
  const topic = state.topic;
  if (!topic || !state.layout.subcats[topic]) {
    list.innerHTML = `<p class="muted">还没有这个主题的论文。</p>`;
    return;
  }

  // Render each subcategory section
  const subcats = state.layout.subcats[topic];
  const sectionsWrap = document.createElement("div");
  sectionsWrap.id = "subcat-wrap";
  list.appendChild(sectionsWrap);

  for (const subcat of subcats) {
    const ids = state.layout.paperOrder[`${topic}:${subcat}`] || [];
    const papers = ids
      .map(id => state.saved[id])
      .filter(Boolean)
      .filter(paperMatchesQuery);

    const section = document.createElement("section");
    section.className = "subcat";
    section.dataset.subcat = subcat;

    const head = document.createElement("div");
    head.className = "subcat-head";
    head.innerHTML = `
      <span class="subcat-handle" title="拖动重排子分类">⋮⋮</span>
      <input class="subcat-name" value="${escapeHtml(subcat)}" />
      <span class="subcat-count">(${papers.length})</span>
      <div class="subcat-actions">
        ${subcat !== "general" ? `<button class="icon-btn delete" title="删除子分类(论文回到 general)">✕</button>` : ""}
      </div>`;
    section.appendChild(head);

    const listEl = document.createElement("div");
    listEl.className = "paper-list";
    listEl.dataset.topic = topic;
    listEl.dataset.subcat = subcat;
    section.appendChild(listEl);

    for (const p of papers) listEl.appendChild(renderPaper(p));

    sectionsWrap.appendChild(section);

    // Wire subcat name rename
    const nameInput = head.querySelector(".subcat-name");
    nameInput.addEventListener("change", () => {
      const newName = nameInput.value.trim();
      if (!newName || newName === subcat) {
        nameInput.value = subcat;
        return;
      }
      if (state.layout.subcats[topic].includes(newName)) {
        alert("已存在同名子分类。");
        nameInput.value = subcat;
        return;
      }
      // Rename: update subcats array and paperOrder key
      const idx = state.layout.subcats[topic].indexOf(subcat);
      state.layout.subcats[topic][idx] = newName;
      state.layout.paperOrder[`${topic}:${newName}`] =
        state.layout.paperOrder[`${topic}:${subcat}`] || [];
      delete state.layout.paperOrder[`${topic}:${subcat}`];
      persistAll();
      renderList();
      renderTopicTabs();
    });

    // Delete subcat button
    const delBtn = head.querySelector(".icon-btn.delete");
    if (delBtn) {
      delBtn.onclick = () => {
        if (!confirm(`删除子分类「${subcat}」?里面的论文会回到 general。`)) return;
        const orphans = state.layout.paperOrder[`${topic}:${subcat}`] || [];
        delete state.layout.paperOrder[`${topic}:${subcat}`];
        state.layout.subcats[topic] = state.layout.subcats[topic].filter(s => s !== subcat);
        const genKey = `${topic}:general`;
        state.layout.paperOrder[genKey] = [...(state.layout.paperOrder[genKey] || []), ...orphans];
        persistAll();
        renderList();
        renderTopicTabs();
      };
    }
  }

  // "+ 新增子分类" button
  const addBtn = document.createElement("button");
  addBtn.className = "subcat-add";
  addBtn.textContent = "+ 新增子分类";
  addBtn.onclick = () => {
    const name = prompt("子分类名称(如:蒸馏理论 / multi-step→few-step):");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (state.layout.subcats[topic].includes(trimmed)) {
      alert("已存在同名子分类。");
      return;
    }
    state.layout.subcats[topic].push(trimmed);
    state.layout.paperOrder[`${topic}:${trimmed}`] = [];
    persistAll();
    renderList();
  };
  list.appendChild(addBtn);

  // Wire up Sortable for subcategory sections
  Sortable.create(sectionsWrap, {
    animation: 150,
    handle: ".subcat-handle",
    onEnd: () => {
      const newOrder = [...sectionsWrap.querySelectorAll("section.subcat")].map(s => s.dataset.subcat);
      state.layout.subcats[topic] = newOrder;
      persistAll();
    },
  });

  // Wire up Sortable for paper lists, sharing a group so papers can move across subcats
  const groupName = `papers-${topic}`;
  for (const listEl of sectionsWrap.querySelectorAll(".paper-list")) {
    Sortable.create(listEl, {
      group: groupName,
      animation: 150,
      handle: ".drag-grip",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: () => updatePaperOrderFromDOM(topic),
    });
  }
}

function updatePaperOrderFromDOM(topic) {
  const sectionsWrap = $("#subcat-wrap");
  if (!sectionsWrap) return;
  for (const listEl of sectionsWrap.querySelectorAll(".paper-list")) {
    const subcat = listEl.dataset.subcat;
    const ids = [...listEl.querySelectorAll("article.paper")].map(a => a.dataset.id);
    state.layout.paperOrder[`${topic}:${subcat}`] = ids;
  }
  persistAll();
  // Update only counts in the headers, not full re-render (avoid breaking drag)
  const sec = sectionsWrap.querySelectorAll("section.subcat");
  for (const s of sec) {
    const cnt = s.querySelector(".paper-list").children.length;
    s.querySelector(".subcat-count").textContent = `(${cnt})`;
  }
}

// ---------- paper card ----------

function renderPaper(p) {
  const art = document.createElement("article");
  art.className = "paper";
  art.dataset.id = p.id;

  const isSaved = !!state.saved[p.id];
  const isTrash = state.view === "trash";
  const isMine  = state.view === "mine";
  if (isMine) art.classList.add("draggable");

  const topicLabels = (p.topics || [])
    .map(k => topicMeta(k).name_zh)
    .map(n => `<span class="tag">${escapeHtml(n)}</span>`)
    .join("");

  const sourceTag = ({ manual: "手动", zhihu: "知乎", xiaohongshu: "小红书", legacy: "旧版" })[p.source];
  const sourceTagHtml = sourceTag
    ? `<span class="source-tag">${escapeHtml(sourceTag)}</span>`
    : "";

  const dragGrip = isMine ? `<span class="drag-grip" title="拖动重排">⋮⋮</span>` : "";

  const summaryZh = p.summary_zh
    ? `<div class="summary-zh">${escapeHtml(p.summary_zh)}</div>`
    : `<div class="summary-zh empty">${state.view === "daily" ? "（中文摘要未生成）" : ""}</div>`;

  const abstractBlock = p.abstract
    ? `<details class="abstract"><summary>原文摘要</summary><p>${escapeHtml(p.abstract)}</p></details>`
    : "";

  const notesBlock = isMine
    ? `<div class="notes">
         <label>我的备注 <span class="saved-mark">已保存</span></label>
         <textarea placeholder="写下你的见解、要点或问题…">${escapeHtml(p.notes || "")}</textarea>
       </div>`
    : "";

  const linkAbs = p.abs_url ? `<a href="${p.abs_url}" target="_blank" rel="noopener">abs</a>` : "";
  const linkPdf = p.pdf_url ? `<a href="${p.pdf_url}" target="_blank" rel="noopener">pdf</a>` : "";
  const linkAlphax = p.alphaxiv_url
    ? `<a class="alphaxiv" href="${p.alphaxiv_url}" target="_blank" rel="noopener" title="alphaxiv 渲染版（含图）">alphaxiv</a>`
    : "";

  let actionBtns;
  if (isTrash) {
    actionBtns = `<button class="icon-btn restore" title="恢复">↩</button>
                  <button class="icon-btn delete"  title="彻底删除">✕</button>`;
  } else {
    actionBtns = `<button class="icon-btn star ${isSaved ? "on" : ""}" title="${isSaved ? "已收藏" : "收藏到「我的」"}">${isSaved ? "★" : "☆"}</button>
                  <button class="icon-btn delete" title="移到回收站">🗑</button>`;
  }

  const dateLine = p.published
    ? p.published.slice(0, 10)
    : (p.added_at ? `添加于 ${p.added_at.slice(0, 10)}` : "");
  const meta = [fmtAuthors(p.authors), dateLine].filter(Boolean).join(" · ");

  art.innerHTML = `
    <h2>${dragGrip}${sourceTagHtml}<a href="${p.abs_url || p.pdf_url || "#"}" target="_blank" rel="noopener">${escapeHtml(p.title || "(无标题)")}</a></h2>
    <div class="authors">${escapeHtml(meta)}</div>
    ${summaryZh}
    ${abstractBlock}
    ${notesBlock}
    <div class="row">
      <div class="tags">${topicLabels}</div>
      <div class="links">
        ${actionBtns}
        ${linkAbs} ${linkPdf} ${linkAlphax}
      </div>
    </div>`;

  // Wire actions
  const starBtn = art.querySelector(".icon-btn.star");
  if (starBtn) starBtn.onclick = () => toggleSave(p);

  const deleteBtn = art.querySelector(".icon-btn.delete");
  if (deleteBtn) deleteBtn.onclick = () => isTrash ? hardDelete(p.id) : sendToTrash(p);

  const restoreBtn = art.querySelector(".icon-btn.restore");
  if (restoreBtn) restoreBtn.onclick = () => restoreFromTrash(p.id);

  // Notes auto-save
  if (isMine) {
    const ta = art.querySelector("textarea");
    const mark = art.querySelector(".saved-mark");
    let timer = null;
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const cur = state.saved[p.id];
        if (!cur) return;
        cur.notes = ta.value;
        persistAll();
        mark.classList.add("show");
        setTimeout(() => mark.classList.remove("show"), 800);
      }, 350);
    });
  }

  return art;
}

// ---------- save / trash ----------

function ensureClientFields(p) {
  if (!p.alphaxiv_url && /^\d{4}\.\d{4,5}/.test(p.id || "")) {
    p.alphaxiv_url = `https://www.alphaxiv.org/abs/${p.id}`;
  }
  if (!p.added_at) p.added_at = new Date().toISOString();
  if (!p.source) p.source = "arxiv";
  if (p.notes === undefined) p.notes = "";
  return p;
}

function toggleSave(paper) {
  if (state.saved[paper.id]) {
    delete state.saved[paper.id];
    removePaperFromLayout(paper.id);
  } else {
    const copy = JSON.parse(JSON.stringify(paper));
    state.saved[paper.id] = ensureClientFields(copy);
    let topic = (paper.topics && paper.topics[0]) || "other";
    if (!DEFAULT_TOPICS.includes(topic)) topic = "other";
    placePaperInLayout(paper.id, topic, "general");
  }
  persistAll();
  renderList();
  renderTopicTabs();
}

function sendToTrash(paper) {
  const copy = JSON.parse(JSON.stringify(paper));
  copy.deleted_at = new Date().toISOString();
  state.trash[paper.id] = copy;
  if (state.saved[paper.id]) {
    delete state.saved[paper.id];
    removePaperFromLayout(paper.id);
  }
  persistAll();
  renderList();
  renderTopicTabs();
}

function restoreFromTrash(id) {
  const p = state.trash[id];
  if (!p) return;
  delete p.deleted_at;
  state.saved[id] = p;
  delete state.trash[id];
  let topic = (p.topics && p.topics[0]) || "other";
  if (!DEFAULT_TOPICS.includes(topic)) topic = "other";
  placePaperInLayout(id, topic, "general");
  persistAll();
  renderList();
  renderTopicTabs();
}

function hardDelete(id) {
  if (!confirm("彻底删除?这条不会再出现在任何地方。")) return;
  delete state.trash[id];
  persistAll();
  renderList();
  renderTopicTabs();
}

// ---------- upload ----------

const ARXIV_ID_RE = /(\d{4}\.\d{4,5})(v\d+)?/;

function parseArxivId(url) {
  const m = url.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+)/i);
  if (m) {
    const idMatch = m[1].match(ARXIV_ID_RE);
    if (idMatch) return idMatch[1];
  }
  const bare = url.trim().match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (bare) return bare[1];
  return null;
}

function detectSource(url) {
  if (/(^|\.)zhihu\.com\//.test(url) || /^https?:\/\/zhuanlan\.zhihu\.com/.test(url))
    return "zhihu";
  if (/(^|\.)xiaohongshu\.com\//.test(url) || /(^|\.)xhslink\.com\//.test(url))
    return "xiaohongshu";
  return "manual";
}

async function fetchArxivMeta(id) {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`arXiv API HTTP ${r.status}`);
  const text = await r.text();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const entry = doc.querySelector("entry");
  if (!entry) throw new Error("arXiv 没返回这个 ID");
  const get = (sel) => (entry.querySelector(sel)?.textContent || "").trim();
  const title = get("title").replace(/\s+/g, " ");
  const summary = get("summary").replace(/\s+/g, " ");
  const published = get("published");
  const authors = [...entry.querySelectorAll("author > name")].map(n => n.textContent.trim());
  return {
    id,
    title,
    abstract: summary,
    authors,
    published,
    abs_url: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
    alphaxiv_url: `https://www.alphaxiv.org/abs/${id}`,
  };
}

async function handleUpload() {
  const urlInput = $("#upload-url");
  const topicSel = $("#upload-topic");
  const btn = $("#upload-btn");
  const url = urlInput.value.trim();
  if (!url) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "处理中…";
  try {
    const id = parseArxivId(url);
    let savedId;
    if (id) {
      if (state.saved[id]) { alert("这篇 arXiv 论文已经在「我的」里了。"); return; }
      const meta = await fetchArxivMeta(id);
      meta.topics = [topicSel.value];
      meta.source = "arxiv";
      state.saved[id] = ensureClientFields(meta);
      savedId = id;
    } else {
      const sid = "url:" + url;
      if (state.saved[sid]) { alert("这条链接已经在「我的」里了。"); return; }
      const source = detectSource(url);
      const placeholder = ({ zhihu: "知乎: ", xiaohongshu: "小红书: " })[source] || "";
      const title = prompt("给这条链接起个标题:", placeholder);
      if (title === null) return;
      state.saved[sid] = ensureClientFields({
        id: sid,
        title: title || url,
        authors: [],
        abstract: "",
        summary_zh: "",
        topics: [topicSel.value],
        published: "",
        abs_url: url,
        pdf_url: "",
        alphaxiv_url: "",
        source,
      });
      savedId = sid;
    }
    placePaperInLayout(savedId, topicSel.value, "general");
    persistAll();
    urlInput.value = "";
    if (state.view === "mine") {
      renderList();
      renderTopicTabs();
    } else {
      alert("已添加到「我的」。切到「我的」标签查看。");
    }
  } catch (e) {
    alert("添加失败:" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------- GitHub Gist sync ----------

const GIST_FILENAME = "arxiv-daily-mine.json";

function setSyncStatus(status, hint = "") {
  state.syncStatus = status;
  const btn = $("#sync-status");
  btn.classList.remove("synced", "syncing", "error");
  if (status === "synced")  btn.classList.add("synced");
  if (status === "syncing") btn.classList.add("syncing");
  if (status === "error")   btn.classList.add("error");
  const labels = { idle: "☁ 同步", disabled: "☁ 同步", syncing: "☁ 同步中", synced: "✓ 已同步", error: "✕ 同步失败" };
  btn.textContent = labels[status] || "☁";
  btn.title = hint || labels[status] || "";
}

function syncEnabled() {
  return !!(state.sync && state.sync.token && state.sync.gistId);
}

async function gistApi(method, path, body, token) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Gist API ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

function collectSyncPayload() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    saved: state.saved,
    trash: state.trash,
    layout: state.layout,
  };
}

function applySyncPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.saved)  state.saved  = payload.saved;
  if (payload.trash)  state.trash  = payload.trash;
  if (payload.layout) state.layout = payload.layout;
  ensureLayout();
  reconcileLayout();
  saveJson(LS.saved,  state.saved);
  saveJson(LS.trash,  state.trash);
  saveJson(LS.layout, state.layout);
}

async function syncPush() {
  if (!syncEnabled()) return;
  setSyncStatus("syncing");
  try {
    const content = JSON.stringify(collectSyncPayload(), null, 2);
    await gistApi("PATCH", `/gists/${state.sync.gistId}`,
      { files: { [GIST_FILENAME]: { content } } },
      state.sync.token);
    state.sync.lastSyncedAt = new Date().toISOString();
    saveJson(LS.sync, state.sync);
    setSyncStatus("synced", `上次同步: ${state.sync.lastSyncedAt}`);
  } catch (e) {
    setSyncStatus("error", e.message);
    console.error(e);
  }
}

async function syncPull() {
  if (!syncEnabled()) return;
  setSyncStatus("syncing");
  try {
    const data = await gistApi("GET", `/gists/${state.sync.gistId}`, null, state.sync.token);
    const file = data.files?.[GIST_FILENAME];
    if (file) {
      const payload = JSON.parse(file.content || "{}");
      applySyncPayload(payload);
    }
    state.sync.lastSyncedAt = new Date().toISOString();
    saveJson(LS.sync, state.sync);
    setSyncStatus("synced", `上次同步: ${state.sync.lastSyncedAt}`);
    renderTopicTabs();
    renderList();
  } catch (e) {
    setSyncStatus("error", e.message);
    console.error(e);
  }
}

const scheduleSync = debounce(() => {
  if (syncEnabled()) syncPush();
}, 2500);

async function connectSync() {
  const tokenInput = $("#sync-token");
  const token = tokenInput.value.trim();
  if (!token) { alert("请先粘贴 token"); return; }

  setSyncStatus("syncing");
  try {
    // If we already had a gist, just save the new token and pull
    if (state.sync.gistId) {
      state.sync.token = token;
      saveJson(LS.sync, state.sync);
      await syncPull();
    } else {
      // Look for existing arxiv-daily gist on this account first
      const list = await gistApi("GET", `/gists?per_page=100`, null, token);
      const existing = list.find(g => g.files && g.files[GIST_FILENAME]);
      if (existing) {
        state.sync = { token, gistId: existing.id, lastSyncedAt: null };
        saveJson(LS.sync, state.sync);
        await syncPull();
      } else {
        // Create a new secret gist
        const gist = await gistApi("POST", "/gists", {
          description: "arxiv-daily personal data",
          public: false,
          files: {
            [GIST_FILENAME]: { content: JSON.stringify(collectSyncPayload(), null, 2) },
          },
        }, token);
        state.sync = { token, gistId: gist.id, lastSyncedAt: new Date().toISOString() };
        saveJson(LS.sync, state.sync);
        setSyncStatus("synced", "已创建新 gist 并上传");
      }
    }
    refreshSyncModalUI();
  } catch (e) {
    setSyncStatus("error", e.message);
    alert("连接失败:" + e.message);
  }
}

function disconnectSync() {
  if (!confirm("断开后,本机将不再同步,但 gist 不会被删除。继续?")) return;
  state.sync = {};
  saveJson(LS.sync, null);
  setSyncStatus("idle");
  refreshSyncModalUI();
}

function refreshSyncModalUI() {
  const connected = syncEnabled();
  $("#sync-pull").hidden        = !connected;
  $("#sync-push").hidden        = !connected;
  $("#sync-disconnect").hidden  = !connected;
  $("#sync-connect").textContent = connected ? "用新 token 重连" : "连接";
  const info = $("#sync-info");
  if (connected) {
    info.innerHTML = `已连接 gist <code>${escapeHtml(state.sync.gistId)}</code>。<br>
                      上次同步: ${escapeHtml(state.sync.lastSyncedAt || "未知")}`;
  } else {
    info.textContent = "未连接。";
  }
}

function openSyncModal() {
  $("#sync-token").value = state.sync.token || "";
  refreshSyncModalUI();
  $("#sync-modal").hidden = false;
}
function closeSyncModal() { $("#sync-modal").hidden = true; }

// ---------- bootstrap ----------

async function main() {
  $("#search").addEventListener("input", e => {
    state.query = e.target.value.trim();
    renderList();
  });

  for (const b of document.querySelectorAll("#view-switch button")) {
    b.onclick = () => setView(b.dataset.view);
  }

  $("#upload-btn").onclick = handleUpload;
  $("#upload-url").addEventListener("keydown", e => {
    if (e.key === "Enter") handleUpload();
  });

  // Sync UI
  $("#sync-status").onclick = openSyncModal;
  $("#sync-modal .modal-close").onclick = closeSyncModal;
  $("#sync-modal").addEventListener("click", e => {
    if (e.target.id === "sync-modal") closeSyncModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("#sync-modal").hidden) closeSyncModal();
  });
  $("#sync-connect").onclick = connectSync;
  $("#sync-pull").onclick = syncPull;
  $("#sync-push").onclick = syncPush;
  $("#sync-disconnect").onclick = disconnectSync;

  // Initial sync status
  if (syncEnabled()) {
    setSyncStatus("syncing", "正在拉取远程数据…");
    syncPull().catch(() => {}); // best-effort, errors are surfaced via status
  } else {
    setSyncStatus("idle", "点击配置云同步");
  }

  // Daily data
  try {
    const idx = await loadIndex();
    state.index = idx;
    if (idx.dates && idx.dates.length) {
      state.date = idx.dates[0];
      buildDateSelect();
      await reloadDate();
    } else {
      setStatus("还没有任何数据。等 GitHub Actions 第一次跑完后再刷新。", true);
      renderTopicTabs();
    }
  } catch (e) {
    setStatus(e.message + "（可能 Actions 还没首次运行）", true);
    renderTopicTabs();
    renderList();
  }
}

main();
