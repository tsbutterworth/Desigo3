const NormalSdk = require("@normalframework/applications-sdk");
const http = require("http");
const https = require("https");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { v5: uuidv5 } = require("uuid");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 9090;
const NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc";
const SELECTION_FILE = path.resolve(
  process.env.DESIGO_SELECTION_FILE || "/data/desigo-selection.json"
);

const norisHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------
let server = null;
let g_config = null;

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
async function authenticate(config) {
  const { data } = await axios.post(
    `${config.baseUrl}/token`,
    new URLSearchParams({
      grant_type: "password",
      username: config.username,
      password: config.password,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
      httpsAgent: norisHttpsAgent,
    }
  );
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Desigo API helpers
// ---------------------------------------------------------------------------
async function fetchChildren(token, systemId, viewId, parentDesignation) {
  const headers = { authorization: `Bearer ${token}` };
  const baseUrl = g_config.baseUrl;

  if (!systemId || !viewId) {
    const resp = await axios.get(`${baseUrl}/systembrowser`, {
      headers, timeout: 20000, httpsAgent: norisHttpsAgent,
    });
    return (resp.data || []).map((v) => ({
      id: `view::${v.SystemId}::${v.ViewId}`,
      name: v.Descriptor || v.Designation,
      designation: v.Designation,
      systemId: v.SystemId,
      viewId: v.ViewId,
      hasChildren: true,
      isLeaf: false,
      objectId: null,
    }));
  }

  const params = { size: 500, page: 1, searchString: "*" };
  if (parentDesignation) params.parentDesignation = parentDesignation;

  const resp = await axios.get(
    `${baseUrl}/systembrowser/${systemId}/${viewId}`,
    { params, headers, timeout: 30000, httpsAgent: norisHttpsAgent }
  );
  const nodes = resp.data?.Nodes || resp.data || [];
  return nodes.map((n) => {
    const attrs = n.Attributes || {};
    return {
      id: n.ObjectId || n.Designation,
      name: n.Name || n.Descriptor,
      designation: n.Designation,
      objectId: n.ObjectId,
      hasChildren: n.HasChildren !== false,
      isLeaf: n.HasChildren === false,
      managedTypeName: attrs.ManagedTypeName || "",
      typeDescriptor: attrs.TypeDescriptor || "",
    };
  });
}

// ---------------------------------------------------------------------------
// Normal points helper — get imported count for hpl:desigocc layer
// ---------------------------------------------------------------------------
async function getImportedCount() {
  try {
    const resp = await axios.get(
      `http://${process.env.NFURL}/api/v1/point/points`,
      { params: { layer: "hpl:desigocc", limit: 1 }, timeout: 10000 }
    );
    return resp.data?.total || resp.data?.points?.length || 0;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Selection file helpers
// ---------------------------------------------------------------------------
function loadSelection() {
  try {
    if (fs.existsSync(SELECTION_FILE)) {
      return JSON.parse(fs.readFileSync(SELECTION_FILE, "utf8"));
    }
  } catch (_) {}
  return { version: 1, points: [] };
}

function saveSelection(points) {
  const dir = path.dirname(SELECTION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    baseUrl: g_config.baseUrl,
    points,
  };
  fs.writeFileSync(SELECTION_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

// ---------------------------------------------------------------------------
// JSON API router
// ---------------------------------------------------------------------------
async function handleApi(pathname, body) {
  // GET /api/status
  if (pathname === "/api/status") {
    const selection = loadSelection();
    const imported = await getImportedCount();
    return {
      connected: true,
      baseUrl: g_config.baseUrl,
      selectedCount: (selection.points || []).length,
      importedCount: imported,
      savedAt: selection.savedAt || null,
    };
  }

  // POST /api/expand
  if (pathname === "/api/expand") {
    const { systemId, viewId, parentDesignation } = body;
    const token = await authenticate(g_config);
    const children = await fetchChildren(token, systemId, viewId, parentDesignation || null);
    const selection = loadSelection();
    const selectedIds = new Set((selection.points || []).map((p) => p.objectId));
    return { children: children.map((c) => ({ ...c, selected: selectedIds.has(c.objectId) })) };
  }

  // GET /api/selection
  if (pathname === "/api/selection") {
    return loadSelection();
  }

  // POST /api/selection
  if (pathname === "/api/selection") {
    const { points } = body;
    const saved = saveSelection(points || []);
    return { saved: true, count: (points || []).length, savedAt: saved.savedAt };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Inline HTML — the full discovery UI
// ---------------------------------------------------------------------------
const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Desigo Point Discovery</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
<style>
:root {
  --bg0: #080c10;
  --bg1: #0d1117;
  --bg2: #131920;
  --bg3: #1a2230;
  --bg4: #1f2a3a;
  --border: rgba(99,178,255,0.08);
  --border2: rgba(99,178,255,0.15);
  --text: #cdd9e5;
  --text2: #768899;
  --text3: #404d5c;
  --accent: #58a6ff;
  --accent-glow: rgba(88,166,255,0.15);
  --accent-border: rgba(88,166,255,0.3);
  --green: #3fb950;
  --green-dim: rgba(63,185,80,0.12);
  --amber: #d29922;
  --amber-dim: rgba(210,153,34,0.12);
  --red: #f85149;
  --mono: 'DM Mono', monospace;
  --sans: 'DM Sans', system-ui, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: var(--sans);
  background: var(--bg0);
  color: var(--text);
  font-size: 13px;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 20px;
  height: 52px;
  background: var(--bg1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo-mark {
  width: 28px; height: 28px;
  border: 1.5px solid var(--accent-border);
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-glow);
}
.logo-mark svg { width: 14px; height: 14px; }
.logo-name {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  letter-spacing: 0.02em;
}
.logo-sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.header-stats {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}
.stat-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid var(--border2);
  background: var(--bg2);
  font-family: var(--mono);
  font-size: 11px;
}
.stat-pill .dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.dot-green { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot-amber { background: var(--amber); }
.dot-blue { background: var(--accent); }
.stat-pill .val { color: var(--text); font-weight: 500; }
.stat-pill .lbl { color: var(--text3); }

/* ── Main layout ── */
.workspace {
  display: grid;
  grid-template-columns: 260px 1fr;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* ── Tree ── */
.sidebar {
  background: var(--bg1);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sidebar-head {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--text3);
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tree-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 4px;
}
.tree-scroll::-webkit-scrollbar { width: 3px; }
.tree-scroll::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.1s;
  position: relative;
  user-select: none;
}
.tree-row:hover { background: var(--bg3); }
.tree-row.active { background: var(--accent-glow); }
.tree-row.active .tree-name { color: var(--accent); }

.tree-chevron {
  width: 14px; height: 14px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--text3);
  font-size: 8px;
  transition: transform 0.15s;
}
.tree-chevron.open { transform: rotate(90deg); color: var(--text2); }
.tree-chevron.leaf { opacity: 0; pointer-events: none; }

.tree-icon { font-size: 12px; flex-shrink: 0; }
.tree-name {
  flex: 1;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-badge {
  font-family: var(--mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--text3);
  flex-shrink: 0;
}
.tree-badge.sel {
  background: var(--accent-glow);
  border-color: var(--accent-border);
  color: var(--accent);
}

.spinner {
  width: 10px; height: 10px; flex-shrink: 0;
  border: 1.5px solid var(--border2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.5s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Right panel ── */
.main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg0);
}
.main-head {
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg1);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.breadcrumb {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text3);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.breadcrumb .active { color: var(--text); font-weight: 500; }

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg1);
  flex-shrink: 0;
}
.filter-lbl {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text3);
  margin-right: 2px;
}
.ftab {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--border2);
  background: transparent;
  color: var(--text2);
  cursor: pointer;
  transition: all 0.1s;
  text-transform: uppercase;
}
.ftab.on { background: var(--accent-glow); color: var(--accent); border-color: var(--accent-border); }
.ftab:hover:not(.on) { color: var(--text); }

.search {
  margin-left: auto;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--sans);
  color: var(--text);
  width: 180px;
  outline: none;
  transition: border-color 0.15s;
}
.search:focus { border-color: var(--accent-border); }
.search::placeholder { color: var(--text3); }

/* ── Points table ── */
.col-head {
  display: grid;
  grid-template-columns: 30px 1fr 100px 1fr 82px;
  padding: 6px 18px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--text3);
  text-transform: uppercase;
  flex-shrink: 0;
}
.points-list { flex: 1; overflow-y: auto; }
.points-list::-webkit-scrollbar { width: 3px; }
.points-list::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

.pt-row {
  display: grid;
  grid-template-columns: 30px 1fr 100px 1fr 82px;
  align-items: center;
  padding: 7px 18px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.08s;
}
.pt-row:hover { background: var(--bg2); }
.pt-row.is-imported { opacity: 0.45; pointer-events: none; }

.pt-row input[type=checkbox] {
  width: 13px; height: 13px;
  cursor: pointer;
  accent-color: var(--accent);
}
.pt-name {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 8px;
}
.pt-type {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
}
.pt-desig {
  font-size: 11px;
  color: var(--text2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 8px;
}
.tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 3px;
  letter-spacing: 0.02em;
}
.tag-importable { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(210,153,34,0.25); }
.tag-imported   { background: var(--green-dim);  color: var(--green);  border: 1px solid rgba(63,185,80,0.2); }

/* ── Empty states ── */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text3);
}
.empty-icon {
  width: 40px; height: 40px;
  border: 1px solid var(--border2);
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  color: var(--text3);
  background: var(--bg2);
}
.empty-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

/* ── Footer ── */
.footer {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  height: 48px;
  border-top: 1px solid var(--border);
  background: var(--bg1);
  flex-shrink: 0;
}
.foot-stat {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text2);
}
.foot-stat strong { color: var(--accent); font-weight: 500; }
.foot-actions { margin-left: auto; display: flex; gap: 8px; }

.btn {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid var(--border2);
  background: transparent;
  color: var(--text2);
  transition: all 0.1s;
}
.btn:hover { color: var(--text); border-color: var(--border2); background: var(--bg3); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--bg0); }
.btn-primary:hover { background: #79baff; border-color: #79baff; color: var(--bg0); }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-ghost { color: var(--text3); border-color: transparent; }
.btn-ghost:hover { color: var(--text2); border-color: var(--border); background: transparent; }

/* ── Toast ── */
.toast {
  position: fixed;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%) translateY(8px);
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 6px;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--green);
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
  white-space: nowrap;
  z-index: 100;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.err { color: var(--red); }

/* ── Import progress overlay ── */
.overlay {
  position: fixed; inset: 0;
  background: rgba(8,12,16,0.85);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(4px);
}
.overlay.show { display: flex; }
.progress-card {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 28px 36px;
  min-width: 320px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.progress-title {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  letter-spacing: 0.04em;
}
.progress-bar-bg {
  height: 3px;
  background: var(--bg4);
  border-radius: 2px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  width: 0%;
  transition: width 0.4s ease;
  box-shadow: 0 0 8px var(--accent);
}
.progress-msg {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text2);
  min-height: 16px;
}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-mark">
      <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="5" height="5" rx="1" fill="#58a6ff" opacity="0.8"/>
        <rect x="8" y="1" width="5" height="5" rx="1" fill="#58a6ff" opacity="0.4"/>
        <rect x="1" y="8" width="5" height="5" rx="1" fill="#58a6ff" opacity="0.4"/>
        <rect x="8" y="8" width="5" height="5" rx="1" fill="#58a6ff" opacity="0.2"/>
      </svg>
    </div>
    <div>
      <div class="logo-name">Desigo Discovery</div>
      <div class="logo-sub">Point Selection</div>
    </div>
  </div>
  <div class="header-stats">
    <div class="stat-pill" id="connPill">
      <span class="dot dot-amber" id="connDot"></span>
      <span class="lbl">status</span>
      <span class="val" id="connLabel">connecting</span>
    </div>
    <div class="stat-pill">
      <span class="dot dot-blue"></span>
      <span class="lbl">selected</span>
      <span class="val" id="selCount">0</span>
    </div>
    <div class="stat-pill">
      <span class="dot dot-green"></span>
      <span class="lbl">in normal</span>
      <span class="val" id="impCount">—</span>
    </div>
  </div>
</div>

<div class="workspace">
  <div class="sidebar">
    <div class="sidebar-head">
      <span>System Browser</span>
    </div>
    <div class="tree-scroll" id="treeRoot">
      <div class="empty" style="height:100%;padding:24px 0">
        <div class="spinner" style="width:16px;height:16px"></div>
      </div>
    </div>
  </div>

  <div class="main" id="mainPanel">
    <div class="empty" style="flex:1">
      <div class="empty-icon">◈</div>
      <div class="empty-label">Select a node to browse points</div>
    </div>
  </div>
</div>

<div class="footer">
  <div class="foot-stat">Selected: <strong id="footSel">0</strong></div>
  <div class="foot-stat" id="footSaved"></div>
  <div class="foot-actions">
    <button class="btn btn-ghost" onclick="clearAll()">Clear all</button>
    <button class="btn btn-primary" id="saveBtn" disabled onclick="saveSelection()">Save selection</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<div class="overlay" id="overlay">
  <div class="progress-card">
    <div class="progress-title" id="progTitle">Saving selection…</div>
    <div class="progress-bar-bg"><div class="progress-bar" id="progBar"></div></div>
    <div class="progress-msg" id="progMsg"></div>
  </div>
</div>

<script>
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  systemId: null,
  viewId: null,
  // tree: nodeId → { node, children, expanded, el }
  tree: new Map(),
  // active right-panel children
  activeChildren: [],
  activeNode: null,
  // selection: objectId → point record
  selection: new Map(),
  // already imported objectIds (from Normal)
  imported: new Set(),
  filter: "importable",
  search: "",
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const status = await api("GET", "/api/status");
    // Connected
    document.getElementById("connDot").className = "dot dot-green";
    document.getElementById("connLabel").textContent = "connected";
    document.getElementById("impCount").textContent = status.importedCount.toLocaleString();

    if (status.savedAt) {
      const d = new Date(status.savedAt);
      document.getElementById("footSaved").textContent =
        "Last saved " + d.toLocaleDateString() + " " + d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    }

    // Load existing selection
    const sel = await api("GET", "/api/selection");
    if (sel.points) {
      for (const p of sel.points) S.selection.set(p.objectId, p);
    }
    updateCounts();

    // Load root tree
    await expandNode(null, null, null, null, document.getElementById("treeRoot"), 0);

  } catch (err) {
    document.getElementById("connDot").className = "dot dot-amber";
    document.getElementById("connLabel").textContent = "error";
    document.getElementById("treeRoot").innerHTML =
      '<div class="empty" style="height:100%;padding:24px 0"><div class="empty-label">Connection failed</div></div>';
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
async function expandNode(nodeId, systemId, viewId, parentDesignation, container, depth) {
  container.innerHTML = '<div style="padding:8px 14px"><div class="spinner"></div></div>';
  try {
    const { children } = await api("POST", "/api/expand", { systemId, viewId, parentDesignation });
    container.innerHTML = "";
    for (const child of children) {
      const wrap = document.createElement("div");
      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.paddingLeft = (8 + depth * 14) + "px";
      row.dataset.id = child.id;

      const chev = document.createElement("span");
      chev.className = "tree-chevron" + (child.isLeaf ? " leaf" : "");
      chev.textContent = "▶";

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.textContent = depth === 0 ? "⬡" : child.isLeaf ? "◈" : "▸";

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = child.name;

      row.appendChild(chev);
      row.appendChild(icon);
      row.appendChild(name);

      const selCount = S.selection.has(child.objectId) ? 1 : 0;
      if (selCount > 0) {
        const badge = document.createElement("span");
        badge.className = "tree-badge sel";
        badge.textContent = selCount;
        row.appendChild(badge);
      }

      row.addEventListener("click", () => handleTreeClick(child, row, wrap, chev, depth));
      wrap.appendChild(row);
      container.appendChild(wrap);

      S.tree.set(child.id, { node: child, children: null, expanded: false, el: wrap, row, chev });
    }
  } catch (err) {
    container.innerHTML = '<div class="empty" style="padding:12px"><div class="empty-label">Failed to load</div></div>';
  }
}

async function handleTreeClick(node, row, wrap, chev, depth) {
  // Mark active
  document.querySelectorAll(".tree-row.active").forEach(r => r.classList.remove("active"));
  row.classList.add("active");
  S.activeNode = node;

  if (node.isLeaf) {
    showPointDetail(node);
    return;
  }

  const entry = S.tree.get(node.id);
  if (entry.expanded) {
    entry.expanded = false;
    chev.classList.remove("open");
    const sub = wrap.querySelector(".tree-children");
    if (sub) sub.remove();
    showEmpty("Select a node to browse points");
    return;
  }

  entry.expanded = true;
  chev.classList.add("open");

  const sysId = node.systemId || S.systemId;
  const vwId = node.viewId || S.viewId;
  if (node.systemId) { S.systemId = node.systemId; S.viewId = node.viewId; }

  // Fetch children
  const spinnerEl = document.createElement("span");
  spinnerEl.className = "spinner";
  chev.replaceWith(spinnerEl);

  let children = [];
  try {
    const res = await api("POST", "/api/expand", {
      systemId: sysId,
      viewId: vwId,
      parentDesignation: node.designation || null,
    });
    children = res.children || [];
    entry.children = children;
  } catch (_) {}

  const newChev = document.createElement("span");
  newChev.className = "tree-chevron open";
  newChev.textContent = "▶";
  spinnerEl.replaceWith(newChev);
  entry.chev = newChev;
  newChev.addEventListener("click", (e) => {
    e.stopPropagation();
    handleTreeClick(node, row, wrap, newChev, depth);
  });

  if (children.length > 0) {
    const sub = document.createElement("div");
    sub.className = "tree-children";
    for (const child of children) {
      const cWrap = document.createElement("div");
      const cRow = document.createElement("div");
      cRow.className = "tree-row";
      cRow.style.paddingLeft = (8 + (depth + 1) * 14) + "px";

      const cChev = document.createElement("span");
      cChev.className = "tree-chevron" + (child.isLeaf ? " leaf" : "");
      cChev.textContent = "▶";

      const cIcon = document.createElement("span");
      cIcon.className = "tree-icon";
      cIcon.textContent = child.isLeaf ? "◈" : "▸";

      const cName = document.createElement("span");
      cName.className = "tree-name";
      cName.textContent = child.name;

      cRow.appendChild(cChev);
      cRow.appendChild(cIcon);
      cRow.appendChild(cName);
      cRow.addEventListener("click", () => handleTreeClick(child, cRow, cWrap, cChev, depth + 1));
      cWrap.appendChild(cRow);
      sub.appendChild(cWrap);
      S.tree.set(child.id, { node: child, children: null, expanded: false, el: cWrap, row: cRow, chev: cChev });
    }
    wrap.appendChild(sub);
  }

  // Show right panel for this node's children
  S.activeChildren = children;
  renderRight(node);
}

// ---------------------------------------------------------------------------
// Right panel
// ---------------------------------------------------------------------------
function showEmpty(msg) {
  document.getElementById("mainPanel").innerHTML =
    '<div class="empty" style="flex:1"><div class="empty-icon">◈</div><div class="empty-label">' + msg + '</div></div>';
}

function renderRight(parentNode) {
  const panel = document.getElementById("mainPanel");
  const children = S.activeChildren;
  const points = children.filter(c => c.isLeaf || !c.hasChildren);
  const branches = children.filter(c => !c.isLeaf && c.hasChildren);
  const filtered = filterPoints(points);

  const crumb = (parentNode.designation || parentNode.name || "").split(".").join(" › ");
  const selInPanel = points.filter(p => S.selection.has(p.objectId)).length;

  panel.innerHTML = \`
    <div class="main-head">
      <div class="breadcrumb">\${crumb.length > 80 ? "…" + crumb.slice(-80) : crumb}</div>
      \${points.length > 0 ? \`<button class="btn btn-primary" onclick="importAll()" style="padding:4px 12px;font-size:10px">Add all (\${points.filter(p=>!S.imported.has(p.objectId)).length})</button>\` : ""}
    </div>
    <div class="filter-row">
      <span class="filter-lbl">Filter</span>
      <button class="ftab \${S.filter==="all"?"on":""}" onclick="setFilter('all')">All</button>
      <button class="ftab \${S.filter==="importable"?"on":""}" onclick="setFilter('importable')">Importable</button>
      <button class="ftab \${S.filter==="imported"?"on":""}" onclick="setFilter('imported')">Imported</button>
      <span style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-left:8px">\${points.length} pts · \${branches.length} branches</span>
      <input class="search" type="text" placeholder="Filter name…" value="\${S.search}" oninput="onSearch(this.value)"/>
    </div>
    \${points.length > 0 ? \`<div class="col-head">
      <div><input type="checkbox" id="chkAll" onchange="toggleAll(this.checked)"/></div>
      <div>Name</div><div>Type</div><div>Designation</div><div>Status</div>
    </div>\` : ""}
    <div class="points-list" id="ptList">
      \${filtered.length === 0 && points.length === 0
        ? \`<div class="empty" style="flex:1;padding:40px 0"><div class="empty-icon">▸</div><div class="empty-label">\${branches.length} sub-branches — expand to see points</div></div>\`
        : filtered.length === 0
        ? \`<div class="empty" style="padding:32px 0"><div class="empty-label">No points match filter</div></div>\`
        : filtered.map(p => renderRow(p)).join("")}
    </div>
  \`;
}

function renderRow(p) {
  const isImported = S.imported.has(p.objectId);
  const isSelected = S.selection.has(p.objectId);
  const tag = isImported
    ? '<span class="tag tag-imported">Imported ✓</span>'
    : '<span class="tag tag-importable">Importable</span>';
  return \`<div class="pt-row \${isImported?"is-imported":""}" onclick="togglePoint('\${p.objectId}','\${p.id}')">
    <div><input type="checkbox" \${isSelected||isImported?"checked":""} \${isImported?"disabled":""} onclick="event.stopPropagation();togglePoint('\${p.objectId}','\${p.id}')"/></div>
    <div class="pt-name">\${p.name||p.id}</div>
    <div class="pt-type">\${p.managedTypeName||"—"}</div>
    <div class="pt-desig">\${p.designation||"—"}</div>
    <div>\${tag}</div>
  </div>\`;
}

function filterPoints(pts) {
  let list = pts;
  if (S.filter === "importable") list = list.filter(p => !S.imported.has(p.objectId));
  if (S.filter === "imported")   list = list.filter(p =>  S.imported.has(p.objectId));
  if (S.search) {
    const q = S.search.toLowerCase();
    list = list.filter(p => (p.name||p.id).toLowerCase().includes(q));
  }
  return list;
}

function setFilter(f) { S.filter = f; if (S.activeNode) renderRight(S.activeNode); }
function onSearch(v)  { S.search = v;  if (S.activeNode) renderRight(S.activeNode); }

function toggleAll(checked) {
  const pts = S.activeChildren.filter(c => (c.isLeaf||!c.hasChildren) && !S.imported.has(c.objectId));
  for (const p of pts) {
    if (checked) S.selection.set(p.objectId, buildRecord(p));
    else         S.selection.delete(p.objectId);
  }
  updateCounts();
  if (S.activeNode) renderRight(S.activeNode);
}

function togglePoint(objectId, fallbackId) {
  if (S.imported.has(objectId)) return;
  const node = S.activeChildren.find(c => c.objectId === objectId || c.id === fallbackId);
  if (S.selection.has(objectId)) S.selection.delete(objectId);
  else if (node) S.selection.set(objectId, buildRecord(node));
  updateCounts();
  if (S.activeNode) renderRight(S.activeNode);
}

function importAll() {
  const pts = S.activeChildren.filter(c => (c.isLeaf||!c.hasChildren) && !S.imported.has(c.objectId));
  for (const p of pts) S.selection.set(p.objectId, buildRecord(p));
  updateCounts();
  if (S.activeNode) renderRight(S.activeNode);
  toast("Added " + pts.length + " points to selection");
}

function buildRecord(node) {
  return {
    objectId: node.objectId || node.id,
    name: node.name,
    designation: node.designation || "",
    managedTypeName: node.managedTypeName || "",
    propertyName: "Present_Value",
  };
}

function showPointDetail(node) {
  const isSelected = S.selection.has(node.objectId);
  document.getElementById("mainPanel").innerHTML = \`
    <div class="main-head">
      <div class="breadcrumb">\${(node.designation||node.name||"").split(".").join(" › ")}</div>
      <button class="btn \${isSelected?"":"btn-primary"}" onclick="togglePoint('\${node.objectId}','\${node.id}');showPointDetailById('\${node.id}')">
        \${isSelected ? "Remove" : "Add to selection"}
      </button>
    </div>
    <div style="padding:24px 18px;display:grid;grid-template-columns:120px 1fr;gap:10px 16px;font-size:12px;align-content:start">
      <span style="color:var(--text3);font-family:var(--mono)">NAME</span><span style="font-family:var(--mono);font-weight:500">\${node.name}</span>
      <span style="color:var(--text3);font-family:var(--mono)">OBJECT ID</span><span style="font-family:var(--mono);color:var(--accent);font-size:11px">\${node.objectId||"—"}</span>
      <span style="color:var(--text3);font-family:var(--mono)">TYPE</span><span>\${node.managedTypeName||"—"}</span>
      <span style="color:var(--text3);font-family:var(--mono)">DESIGNATION</span><span style="font-size:11px;color:var(--text2)">\${node.designation||"—"}</span>
    </div>
  \`;
}

function showPointDetailById(id) {
  const entry = S.tree.get(id);
  if (entry) showPointDetail(entry.node);
}

// ---------------------------------------------------------------------------
// Selection management
// ---------------------------------------------------------------------------
function updateCounts() {
  const n = S.selection.size;
  document.getElementById("selCount").textContent = n.toLocaleString();
  document.getElementById("footSel").textContent = n.toLocaleString();
  document.getElementById("saveBtn").disabled = n === 0;
}

async function saveSelection() {
  const points = Array.from(S.selection.values());
  showOverlay("Saving selection…", 0, "Writing " + points.length + " points to disk…");
  try {
    animateBar(0, 60, 400);
    const result = await api("POST", "/api/selection", { points });
    animateBar(60, 100, 300);
    await delay(400);
    hideOverlay();
    const d = new Date(result.savedAt);
    document.getElementById("footSaved").textContent =
      "Last saved " + d.toLocaleDateString() + " " + d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    toast("Saved " + points.length + " points → desigo-selection.json");
    document.getElementById("saveBtn").disabled = true;
  } catch (err) {
    hideOverlay();
    toast("Save failed: " + err.message, true);
  }
}

function clearAll() {
  S.selection.clear();
  updateCounts();
  if (S.activeNode) renderRight(S.activeNode);
}

// ---------------------------------------------------------------------------
// Overlay / progress
// ---------------------------------------------------------------------------
function showOverlay(title, pct, msg) {
  document.getElementById("progTitle").textContent = title;
  document.getElementById("progMsg").textContent = msg;
  document.getElementById("progBar").style.width = pct + "%";
  document.getElementById("overlay").classList.add("show");
}
function hideOverlay() { document.getElementById("overlay").classList.remove("show"); }
function animateBar(from, to, ms) {
  const bar = document.getElementById("progBar");
  bar.style.transition = "width " + ms + "ms ease";
  bar.style.width = to + "%";
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => { t.className = "toast"; }, 3000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve UI
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return;
  }

  // API routes
  if (pathname.startsWith("/api/")) {
    let body = {};
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => { data += chunk; });
        req.on("end", () => {
          try { resolve(JSON.parse(data || "{}")); }
          catch (e) { reject(e); }
        });
      });
    }

    try {
      const result = await handleApi(pathname, body);
      if (result !== null) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// Main hook — MODE_ON_REQUEST, starts server and keeps it alive
// ---------------------------------------------------------------------------

/**
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config }) => {
  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("Missing username, password, or baseUrl in configuration.");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/g, "");
  g_config = config;

  if (server) {
    sdk.logEvent(`UI server already running on port ${PORT}`);
    return NormalSdk.InvokeResult({ url: `http://localhost:${PORT}`, running: true });
  }

  server = http.createServer(handleRequest);

  await new Promise((resolve, reject) => {
    server.listen(PORT, "0.0.0.0", () => {
      sdk.logEvent(`Desigo Discovery UI running → http://<device-ip>:${PORT}`);
      resolve();
    });
    server.on("error", reject);
  });

  return NormalSdk.InvokeResult({ url: `http://localhost:${PORT}`, running: true });
};
