// arxiv-daily front-end. Three views: daily / mine / trash.
// "我的" supports per-topic subcategories with drag-drop reordering.
// Optional cross-device sync via GitHub Gist.

const BUILD_ID = "2026-04-25.11";  // bump on each frontend change
console.log(`[arxiv-daily] frontend build ${BUILD_ID} loaded`);
window.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("build-marker");
  if (el) el.textContent = `frontend build ${BUILD_ID}`;
});

const $ = (sel) => document.querySelector(sel);

const LS = {
  saved:   "arxiv-daily-saved-v2",   // {[id]: paper}
  trash:   "arxiv-daily-trash-v2",   // {[id]: paper}
  layout:  "arxiv-daily-layout-v1",  // {topicOrder, subcats, paperOrder}
  sync:    "arxiv-daily-sync-v1",    // {token, gistId, lastSyncedAt}
  gemini:  "arxiv-daily-gemini-v1",  // {apiKey, baseUrl, model}
  legacy:  "arxiv-daily-stars",      // legacy stars (array of ids)
};

const GEMINI_SYSTEM_PROMPT =
  "你是一位 AI 研究领域的论文速读助手。" +
  "你将收到一篇 arXiv 论文的英文标题和摘要,请用中文输出该论文的完整解读,要求:" +
  "1) 用 3-4 句话讲清楚:这篇论文要解决什么问题、用了什么方法、关键创新点、实验/结果如何;" +
  "2) 总字数控制在 150-250 字,必须是完整的句子,不要在句子中间结束;" +
  "3) 保留必要的英文术语(如模型名、benchmark 名、关键技术名);" +
  "4) 不要写「这篇论文」「作者」之类的套话,直接讲内容;" +
  "5) 只输出中文摘要正文,不要加任何前缀、标题或 markdown。";

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
  dailyAll: {},          // {date: payload}  loaded all retention dates at once
  activeDate: null,      // currently scrolled-to date in daily view (sidebar highlight)
  topic: "all",
  query: "",
  saved:  loadJson(LS.saved,  {}),
  trash:  loadJson(LS.trash,  {}),
  layout: loadJson(LS.layout, null),
  sync:   loadJson(LS.sync,   {}),
  gemini: loadJson(LS.gemini, {}),
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

function pruneOldTrash() {
  // Auto-delete papers from trash that:
  //   - have been in trash for > 7 days, AND
  //   - are not currently in the user's saved list
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, p] of Object.entries(state.trash)) {
    if (state.saved[id]) continue;  // user re-saved before pruning kicked in
    const t = p.deleted_at ? new Date(p.deleted_at).getTime() : 0;
    if (!t || t < cutoff) {
      delete state.trash[id];
      pruned++;
    }
  }
  if (pruned) {
    console.log(`[trash] auto-pruned ${pruned} entries older than 7 days`);
    saveJson(LS.trash, state.trash);
  }
  return pruned;
}

migrateLegacyStars();
ensureLayout();
reconcileLayout();
pruneOldTrash();
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

async function loadAllDailyData() {
  if (!state.index?.dates) return;
  const dates = state.index.dates;
  setStatus(`加载 ${dates.length} 天的数据…`);
  // Fetch in parallel; keep only those that succeeded
  const results = await Promise.all(
    dates.map(d => loadDate(d).then(p => [d, p]).catch(() => [d, null]))
  );
  state.dailyAll = {};
  for (const [d, p] of results) {
    if (p) state.dailyAll[d] = p;
  }
  const totalPapers = Object.values(state.dailyAll)
    .reduce((s, p) => s + (p.papers || []).length, 0);
  setStatus(`已加载 ${dates.length} 天 · ${totalPapers} 篇`);
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
    // Daily view: count across all loaded dates
    const papers = [];
    for (const d of (state.index?.dates || [])) {
      for (const p of (state.dailyAll[d]?.papers || [])) {
        if (!state.trash[p.id]) papers.push(p);
      }
    }
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

  // Toggle main grid layout: only daily view gets the date sidebar
  const main = $("#main");
  const sidebar = $("#date-sidebar");
  if (state.view === "daily") {
    main.classList.add("with-sidebar");
    sidebar.hidden = false;
  } else {
    main.classList.remove("with-sidebar");
    sidebar.hidden = true;
  }

  if (state.view === "mine") {
    renderMine(list);
  } else if (state.view === "trash") {
    renderTrash(list);
  } else {
    renderDaily(list);
  }
}

function renderTrash(list) {
  const items = Object.values(state.trash);
  // Header bar with empty-trash button
  if (items.length) {
    const bar = document.createElement("div");
    bar.className = "trash-bar";
    bar.innerHTML = `
      <span class="muted small">回收站共 ${items.length} 条 · 超过 7 天且未收藏的条目会自动清理</span>
      <button id="empty-trash-btn" class="ghost-btn danger-btn">🗑 清空回收站</button>`;
    list.appendChild(bar);
    bar.querySelector("#empty-trash-btn").onclick = emptyTrash;
  }
  renderFlatList(list, items);
}

function emptyTrash() {
  const n = Object.keys(state.trash).length;
  if (!n) return;
  if (!confirm(`确认彻底删除回收站里的 ${n} 条?这个操作不可恢复。`)) return;
  state.trash = {};
  persistAll();
  renderList();
  renderTopicTabs();
}

function renderDaily(list) {
  const dates = (state.index?.dates || []).slice().sort().reverse();
  const sidebarItems = [];
  let totalShown = 0;

  for (const date of dates) {
    const all = (state.dailyAll[date]?.papers || []).filter(p => !state.trash[p.id]);
    let papers = all;
    if (state.topic !== "all") {
      papers = papers.filter(p => (p.topics || []).includes(state.topic));
    }
    papers = papers.filter(paperMatchesQuery);
    sidebarItems.push({ date, count: papers.length, totalForDay: all.length });
    if (!papers.length) continue;
    totalShown += papers.length;

    const sec = document.createElement("section");
    sec.className = "date-section";
    sec.id = `date-section-${date}`;
    sec.dataset.date = date;

    const h = document.createElement("h3");
    h.className = "date-header";
    h.textContent = `${date} · ${papers.length} 篇`;
    sec.appendChild(h);

    for (const p of papers) sec.appendChild(renderPaper(p));
    list.appendChild(sec);
  }

  if (!totalShown) {
    list.innerHTML = `<p class="muted">没有匹配的论文。</p>`;
  }

  renderDateSidebar(sidebarItems);
  setupDateScrollSpy();
}

function renderDateSidebar(items) {
  const bar = $("#date-sidebar");
  bar.innerHTML = "";
  if (!items.length) return;
  const header = document.createElement("h4");
  header.textContent = "日期";
  bar.appendChild(header);
  for (const it of items) {
    const a = document.createElement("a");
    a.href = `#date-section-${it.date}`;
    a.dataset.date = it.date;
    const dateShort = it.date.slice(5);  // "MM-DD"
    a.innerHTML = `${escapeHtml(dateShort)} <span class="cnt">${it.count}</span>`;
    if (!it.count) a.style.opacity = "0.4";
    a.onclick = (e) => {
      e.preventDefault();
      const target = document.getElementById(`date-section-${it.date}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      _setActiveDate(it.date);
    };
    bar.appendChild(a);
  }
  if (state.activeDate) _setActiveDate(state.activeDate, false);
}

function _setActiveDate(date, scroll = false) {
  state.activeDate = date;
  const bar = $("#date-sidebar");
  for (const a of bar.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.date === date);
  }
}

let _scrollSpyObserver = null;
function setupDateScrollSpy() {
  if (_scrollSpyObserver) _scrollSpyObserver.disconnect();
  if (!("IntersectionObserver" in window)) return;
  _scrollSpyObserver = new IntersectionObserver((entries) => {
    // Pick the topmost intersecting section
    const visible = entries
      .filter(e => e.isIntersecting)
      .map(e => e.target.dataset.date)
      .filter(Boolean);
    if (visible.length) {
      const sorted = visible.sort();  // dates are ISO so sort works lexically
      _setActiveDate(sorted[sorted.length - 1]);
    }
  }, { rootMargin: "-100px 0px -60% 0px", threshold: 0 });
  for (const sec of document.querySelectorAll(".date-section")) {
    _scrollSpyObserver.observe(sec);
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

  // Wire up Sortable for paper lists. Paper lists share a group so papers
  // can move across subcats. Cross-topic drag is detected via a GLOBAL
  // mousemove listener attached during the drag (onMove only fires when
  // hovering another Sortable, so it can't see the tab nav).
  const groupName = `papers-mine`;
  for (const listEl of sectionsWrap.querySelectorAll(".paper-list")) {
    Sortable.create(listEl, {
      group: groupName,
      animation: 150,
      handle: ".drag-grip",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onStart: () => {
        document.addEventListener("mousemove", _onDragMove, true);
        document.addEventListener("touchmove", _onDragTouchMove, { passive: true });
      },
      onEnd: (evt) => {
        document.removeEventListener("mousemove", _onDragMove, true);
        document.removeEventListener("touchmove", _onDragTouchMove);

        // Try multiple sources to figure out where the user released the drag.
        // 1) The originalEvent (mouseup/touchend) coordinates
        // 2) The currently hovered tab tracked during drag
        let droppedTopic = null;
        const orig = evt.originalEvent;
        let x = null, y = null;
        if (orig) {
          if (orig.changedTouches && orig.changedTouches.length) {
            x = orig.changedTouches[0].clientX;
            y = orig.changedTouches[0].clientY;
          } else if (orig.clientX != null) {
            x = orig.clientX; y = orig.clientY;
          }
        }
        if (x != null && y != null) {
          const tab = document.elementFromPoint(x, y)?.closest("#topic-tabs button[data-topic]");
          if (tab) droppedTopic = tab.dataset.topic;
        }
        if (!droppedTopic && _hoveredTab) {
          droppedTopic = _hoveredTab.dataset?.topic || null;
        }
        clearTabHover();

        console.log("[drag] onEnd: dropped on", droppedTopic, "from topic", topic, " (mouseXY=", x, y, ")");

        if (droppedTopic && droppedTopic !== topic) {
          const id = evt.item.dataset.id;
          if (id) {
            removePaperFromLayout(id);
            placePaperInLayout(id, droppedTopic, "general");
            persistAll();
            state.topic = droppedTopic;
            renderTopicTabs();
            renderList();
            return;
          }
        }
        updatePaperOrderFromDOM(topic);
      },
    });
  }
}

// ---------- Tab hover during paper drag (global mouse tracking) ----------

let _hoveredTab = null;
function _onDragMove(e) { _checkHover(e.clientX, e.clientY); }
function _onDragTouchMove(e) {
  const t = e.touches && e.touches[0];
  if (t) _checkHover(t.clientX, t.clientY);
}
function _checkHover(x, y) {
  if (x == null || y == null) return;
  const target = document.elementFromPoint(x, y);
  const tab = target?.closest("#topic-tabs button[data-topic]");
  if (tab !== _hoveredTab) {
    if (_hoveredTab) _hoveredTab.classList.remove("drop-target");
    _hoveredTab = tab || null;
    if (_hoveredTab) _hoveredTab.classList.add("drop-target");
  }
}
function clearTabHover() {
  const t = _hoveredTab;
  if (_hoveredTab) {
    _hoveredTab.classList.remove("drop-target");
    _hoveredTab = null;
  }
  return t?.dataset.topic || null;
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

  // Chinese summary block:
  //  - daily/trash: read-only div
  //  - mine + has summary: editable textarea (saves on blur)
  //  - mine + no summary: status message ("生成中…" or "请在设置里配置 key")
  let summaryZh;
  if (isMine) {
    if (p.summary_zh) {
      summaryZh = `<div class="summary-zh">
        <textarea class="summary-zh-edit" spellcheck="false"
          placeholder="中文摘要(可编辑)…">${escapeHtml(p.summary_zh)}</textarea>
        <span class="saved-mark summary-saved-mark">已保存</span>
      </div>`;
    } else if (p._summarizing) {
      summaryZh = `<div class="summary-zh empty">⏳ 正在生成中文摘要…</div>`;
    } else if (p.abstract) {
      const hasKey = !!state.gemini?.apiKey;
      summaryZh = `<div class="summary-zh empty">
        <button class="gen-summary-btn">${hasKey ? "重试生成中文摘要" : "生成中文摘要"}</button>
        ${hasKey ? "" : `<span class="muted small" style="margin-left:8px">先在 ☁ 设置里配 Gemini key</span>`}
      </div>`;
    } else {
      summaryZh = `<div class="summary-zh empty">(无英文摘要可用)</div>`;
    }
  } else {
    summaryZh = p.summary_zh
      ? `<div class="summary-zh">${escapeHtml(p.summary_zh)}</div>`
      : `<div class="summary-zh empty">${state.view === "daily" ? "（中文摘要未生成）" : ""}</div>`;
  }

  const abstractBlock = p.abstract
    ? `<details class="abstract"><summary>原文摘要</summary><p>${escapeHtml(p.abstract)}</p></details>`
    : "";

  const hasNotes = !!(p.notes && p.notes.trim());
  const notesBlock = isMine
    ? `<details class="notes ${hasNotes ? "has-content" : ""}" ${hasNotes ? "open" : ""}>
         <summary>我的备注<span class="has-dot" title="已记录"></span><span class="saved-mark">已保存</span></summary>
         <div class="notes-body">
           <textarea placeholder="写下你的见解、要点或问题…">${escapeHtml(p.notes || "")}</textarea>
         </div>
       </details>`
    : "";

  // Thumbnail only in 我的 (daily has too many cards to fetch PDFs for)
  const showThumb = isMine && !!p.pdf_url && /arxiv\.org\/pdf\//.test(p.pdf_url);
  const thumbBlock = showThumb
    ? `<div class="thumb" data-pdf="${p.pdf_url}">
         <div class="thumb-status">滚到此处加载…</div>
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
    <div class="body">
      <div class="authors">${escapeHtml(meta)}</div>
      ${summaryZh}
      ${abstractBlock}
      ${notesBlock}
    </div>
    ${thumbBlock}
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

  // Generate-summary button
  const genBtn = art.querySelector(".gen-summary-btn");
  if (genBtn) genBtn.onclick = () => generateSummaryFor(p.id);

  // Editable summary textarea (mine view, when summary exists)
  const sumTa = art.querySelector(".summary-zh-edit");
  if (sumTa) {
    // Auto-grow on input
    const grow = () => { sumTa.style.height = "auto"; sumTa.style.height = sumTa.scrollHeight + "px"; };
    setTimeout(grow, 0);
    const sumMark = art.querySelector(".summary-saved-mark");
    let sumTimer = null;
    sumTa.addEventListener("input", () => {
      grow();
      clearTimeout(sumTimer);
      sumTimer = setTimeout(() => {
        const cur = state.saved[p.id];
        if (!cur) return;
        cur.summary_zh = sumTa.value;
        persistAll();
        if (sumMark) {
          sumMark.classList.add("show");
          setTimeout(() => sumMark.classList.remove("show"), 800);
        }
      }, 350);
    });
  }

  // Notes auto-save
  if (isMine) {
    const ta = art.querySelector("textarea");
    const mark = art.querySelector(".saved-mark");
    const detailsEl = art.querySelector("details.notes");
    let timer = null;
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const cur = state.saved[p.id];
        if (!cur) return;
        cur.notes = ta.value;
        // Update the visual indicator immediately
        if (cur.notes.trim()) detailsEl.classList.add("has-content");
        else detailsEl.classList.remove("has-content");
        persistAll();
        mark.classList.add("show");
        setTimeout(() => mark.classList.remove("show"), 800);
      }, 350);
    });
  }

  // Lazy-load PDF thumbnail when scrolled into view
  const thumbEl = art.querySelector(".thumb");
  if (thumbEl && window.pdfjsLib && _thumbObserver) {
    _thumbObserver.observe(thumbEl);
  }

  return art;
}

// ---------- PDF thumbnails ----------

const _thumbCache = new Map(); // pdfUrl -> data URL (in-memory only)
const _thumbInflight = new Map();

async function _fetchPdfBytes(pdfUrl) {
  // arxiv.org doesn't expose CORS on PDFs; try multiple proxies, sanity-check
  // each response actually starts with %PDF.
  const candidates = [
    pdfUrl,  // direct (works on the few arxiv mirrors that allow it)
    `https://corsproxy.io/?${encodeURIComponent(pdfUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(pdfUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(pdfUrl)}`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { cache: "force-cache" });
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status} (${url.slice(0, 40)}…)`); continue; }
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 1000) {
        lastErr = new Error(`response too small (${buf.byteLength}b)`);
        continue;
      }
      const head = String.fromCharCode(...new Uint8Array(buf, 0, 5));
      if (!head.startsWith("%PDF")) {
        lastErr = new Error(`not a PDF (head: ${JSON.stringify(head)})`);
        continue;
      }
      return new Uint8Array(buf);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all proxies failed");
}

async function _renderPdfThumb(pdfUrl) {
  if (_thumbCache.has(pdfUrl)) return _thumbCache.get(pdfUrl);
  if (_thumbInflight.has(pdfUrl)) return _thumbInflight.get(pdfUrl);

  const promise = (async () => {
    const bytes = await _fetchPdfBytes(pdfUrl);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    const targetWidth = 280;
    const scale = targetWidth / viewport.width;
    const v2 = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = v2.width;
    canvas.height = v2.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: v2 }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    _thumbCache.set(pdfUrl, dataUrl);
    return dataUrl;
  })();
  _thumbInflight.set(pdfUrl, promise);
  try { return await promise; }
  finally { _thumbInflight.delete(pdfUrl); }
}

const _thumbObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        _thumbObserver.unobserve(el);
        const pdfUrl = el.dataset.pdf;
        if (!pdfUrl) continue;
        el.querySelector(".thumb-status").textContent = "加载中…";
        try {
          const dataUrl = await _renderPdfThumb(pdfUrl);
          el.innerHTML = `<a class="zoom" href="${pdfUrl}" target="_blank" rel="noopener" title="打开 PDF"></a>
                          <img src="${dataUrl}" alt="封面" />`;
        } catch (e) {
          console.warn("thumb fail:", pdfUrl, e);
          el.innerHTML = `<div class="thumb-status">无预览<br><a href="${pdfUrl}" target="_blank" rel="noopener">打开 PDF</a></div>`;
        }
      }
    }, { rootMargin: "200px" })
  : null;

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
    autoGenIfNeeded(paper.id);
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

function parseArxivXml(xmlText, id) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
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

async function fetchArxivMeta(id) {
  const direct = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  // Try direct first, then fall back through CORS / network proxies in order.
  // (Public proxies are best-effort — if all fail, surface the original error.)
  const proxies = [
    direct,
    `https://corsproxy.io/?${encodeURIComponent(direct)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(direct)}`,
  ];
  let lastErr = null;
  for (const url of proxies) {
    try {
      const r = await fetch(url, { mode: "cors" });
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status} (${url})`); continue; }
      const text = await r.text();
      return parseArxivXml(text, id);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `无法连接 arXiv 接口(可能是网络/CORS问题): ${lastErr?.message || "unknown"}。\n` +
    `你可以直接把这条以「其他」方式添加,标题手动填写。`
  );
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
      let meta;
      try {
        meta = await fetchArxivMeta(id);
      } catch (e) {
        const fallback = confirm(
          `自动获取 arXiv 元数据失败:\n${e.message}\n\n` +
          `要不要直接以纯 URL 方式添加?(标题手动填,以后能编辑)`
        );
        if (!fallback) return;
        const t = prompt("给这条 arXiv 链接起个标题:", `arXiv:${id}`);
        if (t === null) return;
        meta = {
          id,
          title: t || `arXiv:${id}`,
          authors: [],
          abstract: "",
          published: "",
          abs_url: `https://arxiv.org/abs/${id}`,
          pdf_url: `https://arxiv.org/pdf/${id}`,
          alphaxiv_url: `https://www.alphaxiv.org/abs/${id}`,
        };
      }
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
    autoGenIfNeeded(savedId);
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

// ---------- Browser-side Gemini summary ----------

async function callGeminiClient(title, abstract) {
  const cfg = state.gemini || {};
  if (!cfg.apiKey) throw new Error("尚未配置 Gemini API key,请先在 ☁ 设置里填写。");
  const baseUrl = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const model   = cfg.model   || "gemini-2.5-flash";
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

  const body = {
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `Title: ${title}\n\nAbstract: ${abstract}` }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      responseMimeType: "text/plain",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const headers = { "Content-Type": "application/json" };

  // Try direct first; on CORS/network failure, route through corsproxy.io.
  const candidates = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];
  let lastErr = null;
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "POST", headers, body: JSON.stringify(body) });
      const txt = await r.text();
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`); continue; }
      const data = JSON.parse(txt);
      const cand = (data.candidates || [])[0];
      if (!cand) throw new Error("no candidates: " + JSON.stringify(data.promptFeedback || {}));
      const parts = (cand.content?.parts) || [];
      const text = parts.map(p => p.text || "").join("").trim();
      if (!text) throw new Error("empty response (finishReason=" + cand.finishReason + ")");
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("unknown");
}

async function generateSummaryFor(paperId, opts = {}) {
  const p = state.saved[paperId];
  if (!p) return;
  if (!p.abstract) {
    if (!opts.silent) alert("这篇没有英文摘要,无法生成中文摘要。");
    return;
  }
  if (!state.gemini.apiKey) {
    if (!opts.silent) {
      alert("先在 ☁ 设置里配置 Gemini API key。");
      openSyncModal();
    }
    return;
  }
  // Mark in-flight so renderList shows "生成中…" placeholder
  p._summarizing = true;
  if (!opts.skipRender) renderList();
  try {
    const text = await callGeminiClient(p.title, p.abstract);
    p.summary_zh = text;
    delete p._summarizing;
    persistAll();
    renderList();
  } catch (e) {
    delete p._summarizing;
    if (!opts.silent) {
      alert("生成失败:" + e.message);
      renderList();
    } else {
      console.warn("[gen] silent fail for", paperId, e);
      renderList();
    }
  }
}

// Auto-generate summary if Gemini is configured and paper is missing one.
// Fires for newly starred / newly uploaded papers. Best-effort, never alerts.
function autoGenIfNeeded(paperId) {
  const p = state.saved[paperId];
  if (!p) return;
  if (p.summary_zh) return;
  if (!p.abstract) return;
  if (!state.gemini?.apiKey) return;
  generateSummaryFor(paperId, { silent: true, skipRender: true });
}

async function generateAllMissingSummaries() {
  const missing = Object.values(state.saved).filter(p => !p.summary_zh && p.abstract);
  if (!missing.length) { alert("所有论文都有摘要了。"); return; }
  if (!state.gemini.apiKey) { alert("先配置 Gemini API key。"); openSyncModal(); return; }
  if (!confirm(`将依次为 ${missing.length} 篇论文生成中文摘要,可能耗时几分钟。继续?`)) return;
  for (const p of missing) {
    try {
      p.summary_zh = await callGeminiClient(p.title, p.abstract);
      persistAll();
      renderList();
    } catch (e) {
      console.warn("[gen] fail:", p.id, e);
    }
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
  $("#gemini-key").value   = state.gemini.apiKey || "";
  $("#gemini-base").value  = state.gemini.baseUrl || "";
  $("#gemini-model").value = state.gemini.model || "";
  refreshSyncModalUI();
  refreshGeminiModalUI();
  $("#sync-modal").hidden = false;
}
function closeSyncModal() { $("#sync-modal").hidden = true; }

function refreshGeminiModalUI() {
  const has = !!state.gemini?.apiKey;
  $("#gemini-clear").hidden = !has;
  const info = $("#gemini-info");
  if (has) {
    info.innerHTML = `已配置 base=<code>${escapeHtml(state.gemini.baseUrl || "(默认 Google)")}</code>
                      model=<code>${escapeHtml(state.gemini.model || "gemini-2.5-flash")}</code>`;
  } else {
    info.textContent = "未配置。";
  }
}

function saveGeminiConfig() {
  const apiKey = $("#gemini-key").value.trim();
  const baseUrl = $("#gemini-base").value.trim();
  const model = $("#gemini-model").value.trim();
  if (!apiKey) { alert("请填写 API key"); return; }
  state.gemini = { apiKey, baseUrl, model };
  saveJson(LS.gemini, state.gemini);
  refreshGeminiModalUI();
  alert("已保存。手动添加论文时点「生成中文摘要」按钮即可调用。");
}

function clearGeminiConfig() {
  if (!confirm("清除浏览器里存的 Gemini key?")) return;
  state.gemini = {};
  saveJson(LS.gemini, null);
  $("#gemini-key").value = "";
  $("#gemini-base").value = "";
  $("#gemini-model").value = "";
  refreshGeminiModalUI();
}

// ---------- bootstrap ----------

// ---------- Theme toggle ----------

const THEME_LS = "arxiv-daily-theme";
const THEME_CYCLE = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "🌗", light: "☀", dark: "🌙" };
const THEME_TITLE = { auto: "跟随系统(点击切换)", light: "浅色(点击切换)", dark: "深色(点击切换)" };

function applyTheme(theme) {
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
  localStorage.setItem(THEME_LS, theme);
  const btn = $("#theme-toggle");
  if (btn) {
    btn.textContent = THEME_LABEL[theme];
    btn.title = THEME_TITLE[theme];
  }
}

function cycleTheme() {
  const cur = localStorage.getItem(THEME_LS) || "auto";
  const idx = THEME_CYCLE.indexOf(cur);
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  applyTheme(next);
}

// Apply saved theme as early as possible to avoid flash
applyTheme(localStorage.getItem(THEME_LS) || "auto");

async function main() {
  $("#theme-toggle").onclick = cycleTheme;
  applyTheme(localStorage.getItem(THEME_LS) || "auto");  // re-apply now that DOM is ready

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
  $("#gemini-save").onclick = saveGeminiConfig;
  $("#gemini-clear").onclick = clearGeminiConfig;

  // Initial sync status
  if (syncEnabled()) {
    setSyncStatus("syncing", "正在拉取远程数据…");
    syncPull().catch(() => {}); // best-effort, errors are surfaced via status
  } else {
    setSyncStatus("idle", "点击配置云同步");
  }

  // Daily data: load index then all per-date files in parallel
  try {
    const idx = await loadIndex();
    state.index = idx;
    if (idx.dates && idx.dates.length) {
      await loadAllDailyData();
      renderTopicTabs();
      renderList();
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
