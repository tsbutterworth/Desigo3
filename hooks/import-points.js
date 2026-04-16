const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NAMESPACE  = "fe927c12-7f2f-11ee-a65f-af8737c274cc";
const BATCH_SIZE = 100;
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

// Shared selection file — poll-values.js reads this to know what to poll.
// Both hooks must share this path (use a shared volume in production).
const SELECTION_FILE = path.resolve(
  process.env.DESIGO_SELECTION_FILE || "/data/desigo-selection.json"
);

const norisHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// Value property candidates — tried in order, first match wins.
const VALUE_PROPERTY_CANDIDATES = ["Present_Value", "Value", "Output_Value"];

function resolveValueProperty(props) {
  for (const name of VALUE_PROPERTY_CANDIDATES) {
    const found = props.find((p) => p.PropertyName === name);
    if (found) return found;
  }
  return null;
}

// Non-operational managed types — no real-time value, skip.
const EXCLUDED_MANAGED_TYPES = new Set([
  "TrendLog", "TrendLogMultiple", "BACnet Notification Class",
  "BACnet Event Enrollment", "TextGroup", "BACnet Schedule",
  "BACnet Calendar", "Schedule", "Calendar", "Journaling",
  "Graphic", "Graphic Template", "Aggregator", "Report",
  "Reaction", "LogicProgram", "AlertConfig",
]);
const EXCLUDED_TYPE_IDS = new Set([4500, 4600, 6900, 8000, 1000]);

function isOperationalNode(node) {
  const attrs = node.Attributes;
  if (!attrs) return false;
  if (attrs.ManagedTypeName && EXCLUDED_MANAGED_TYPES.has(attrs.ManagedTypeName)) return false;
  if (attrs.TypeId != null && EXCLUDED_TYPE_IDS.has(attrs.TypeId)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function authenticate(http, config) {
  const { data } = await http.post(
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
  return { token: data.access_token, userName: data.user_name };
}

async function logout(http, baseUrl, token) {
  try {
    await http.delete(`${baseUrl}/token`, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 10000,
      httpsAgent: norisHttpsAgent,
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Heartbeat — keeps NORIS session alive during long discovery runs
// ---------------------------------------------------------------------------
class HeartbeatManager {
  constructor(http, baseUrl, token) {
    this._http = http; this._baseUrl = baseUrl; this._token = token; this._timer = null;
  }
  start() {
    this._timer = setInterval(async () => {
      try {
        await this._http.get(`${this._baseUrl}/heartbeat`, {
          headers: { authorization: `Bearer ${this._token}` },
          timeout: 10000,
          httpsAgent: norisHttpsAgent,
        });
      } catch (err) { console.warn("Heartbeat failed:", err.message); }
    }, HEARTBEAT_INTERVAL_MS);
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
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

function saveSelection(baseUrl, points) {
  const dir = path.dirname(SELECTION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { version: 1, savedAt: new Date().toISOString(), baseUrl, points };
  fs.writeFileSync(SELECTION_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

// ---------------------------------------------------------------------------
// Systembrowser — fetch one level of children (lazy, on expand)
// ---------------------------------------------------------------------------
async function fetchChildren(http, baseUrl, token, systemId, viewId, parentDesignation) {
  const headers = { authorization: `Bearer ${token}` };

  if (!systemId || !viewId) {
    // Root: list available views
    const resp = await http.get(`${baseUrl}/systembrowser`, {
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

  const resp = await http.get(
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
      objectModelName: attrs.ObjectModelName || "",
    };
  });
}

// ---------------------------------------------------------------------------
// Full paginated scan of a branch — registers points in Normal + saves JSON
// ---------------------------------------------------------------------------
async function runDiscover(http, baseUrl, token, systemId, viewId, rootDesignation, sdk) {
  const authHeaders = { authorization: `Bearer ${token}` };
  let page = 1;
  let totalNodes = 0;
  const points = [];

  // Device anchor
  await http.post(`http://${process.env.NFURL}/api/v1/point/points`, {
    points: [{ layer: "hpl:desigocc", uuid: NAMESPACE, parent_uuid: NAMESPACE, name: baseUrl, point_type: "DEVICE" }],
  });

  while (true) {
    let nodesResp;
    try {
      nodesResp = await http.get(
        `${baseUrl}/systembrowser/${systemId}/${viewId}`,
        {
          params: { size: BATCH_SIZE, page, searchString: "*", parentDesignation: rootDesignation },
          headers: authHeaders, timeout: 30000, httpsAgent: norisHttpsAgent,
        }
      );
    } catch (err) {
      sdk.logEvent(`Error fetching page ${page}: ${err.message}`);
      break;
    }

    const nodes = nodesResp.data?.Nodes || [];
    if (nodes.length === 0) break;
    totalNodes += nodes.length;

    const operational = nodes.filter(isOperationalNode);
    if (operational.length === 0) { page++; if (nodes.length < BATCH_SIZE) break; continue; }

    const objectIds = operational.map((n) => n.ObjectId);
    const nodeMap = new Map(operational.map((n) => [n.ObjectId, n]));

    let propData;
    try {
      const propReply = await http.post(
        `${baseUrl}/properties?readAllProperties=true&requestType=2`,
        objectIds,
        { headers: { ...authHeaders, "Content-Type": "application/json" }, timeout: 30000, httpsAgent: norisHttpsAgent }
      );
      propData = propReply.data;
    } catch (err) {
      sdk.logEvent(`Property fetch error page ${page}: ${err.message}`);
      page++; if (nodes.length < BATCH_SIZE) break; continue;
    }

    const batch = [];
    for (const pointData of propData) {
      if (pointData.ErrorCode && pointData.ErrorCode !== 0) continue;
      const node = nodeMap.get(pointData.ObjectId);
      if (!node) continue;
      const valueProp = resolveValueProperty(pointData.Properties || []);
      if (!valueProp) continue;

      const systemName = node.Designation.split(":")[0];
      const fullObjectName = `${pointData.ObjectId}.${valueProp.PropertyName}`;

      batch.push({
        layer: "hpl:desigocc",
        uuid: uuidv5(fullObjectName, NAMESPACE),
        name: `${node.Name}:${valueProp.PropertyName}`,
        parent_uuid: NAMESPACE,
        parent_name: systemName,
        protocol_id: fullObjectName,
        hpl_driver: "hpl:desigocc",
        attrs: {
          objectId: fullObjectName,
          designation: node.Designation,
          designationTokens:
            node.Designation.replace(/[_.]/g, " ") + " " + fullObjectName.replace(/[_.:]/g, " "),
          managedTypeName: node.Attributes?.ManagedTypeName || "",
          objectModelName: node.Attributes?.ObjectModelName || "",
          systemName,
          propertyName: valueProp.PropertyName,
          propertyType: valueProp.Type || "",
          typeDescriptor: node.Attributes?.TypeDescriptor || "",
          unitDescriptor: valueProp.UnitDescriptor || "",
        },
        point_type: "POINT",
      });
    }

    if (batch.length > 0) {
      await http.post(
        `http://${process.env.NFURL}/api/v1/point/points`,
        { points: batch },
        { timeout: 30000 }
      );
      points.push(...batch);
    }

    sdk.logEvent(`Page ${page}: ${nodes.length} nodes → ${batch.length} points registered (total ${points.length})`);
    page++;
    if (nodes.length < BATCH_SIZE) break;
  }

  sdk.logEvent(`Discovery complete: ${points.length} points from ${totalNodes} nodes under "${rootDesignation}"`);
  return points;
}

// ---------------------------------------------------------------------------
// Main hook
//
// Modes (set via config.action):
//   listViews      List root systembrowser views (default — helps user find systemId/viewId)
//   expand         Lazy-load one level of children for a designation
//   discover       Full paginated scan of config.rootDesignation → Normal + JSON
//   saveSelection  Persist a curated point list to JSON only (no Normal registration)
//   loadSelection  Return the current JSON selection
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

  const http = axios;
  const action = config.action || "listViews";

  // No-auth actions
  if (action === "loadSelection") {
    const sel = loadSelection();
    sdk.logEvent(`Selection: ${(sel.points || []).length} points from ${SELECTION_FILE}`);
    return NormalSdk.InvokeResult(sel);
  }

  if (action === "saveSelection") {
    const points = config.points || [];
    saveSelection(config.baseUrl, points);
    sdk.logEvent(`Saved ${points.length} points to ${SELECTION_FILE}`);
    return NormalSdk.InvokeResult({ saved: true, count: points.length, file: SELECTION_FILE });
  }

  // Authenticated actions
  let token, userName;
  try {
    ({ token, userName } = await authenticate(http, config));
    sdk.logEvent(`Authenticated as ${userName}`);
  } catch (err) {
    return NormalSdk.InvokeError(`Authentication failed: ${err.response?.data?.Details || err.message}`);
  }

  const heartbeat = new HeartbeatManager(http, config.baseUrl, token);
  heartbeat.start();

  try {
    if (action === "listViews") {
      const views = await fetchChildren(http, config.baseUrl, token, null, null, null);
      const selection = loadSelection();
      sdk.logEvent(`Root views: ${views.length} — set systemId and viewId in config to browse further`);
      for (const v of views) {
        sdk.logEvent(`  systemId=${v.systemId}  viewId=${v.viewId}  name="${v.name}"`);
      }
      return NormalSdk.InvokeResult({ views, selection });
    }

    if (action === "expand") {
      const children = await fetchChildren(
        http, config.baseUrl, token,
        config.systemId, config.viewId,
        config.parentDesignation || null
      );
      const selection = loadSelection();
      const selectedIds = new Set((selection.points || []).map((p) => p.objectId));
      sdk.logEvent(`Expanded "${config.parentDesignation || "root"}": ${children.length} children`);
      return NormalSdk.InvokeResult({
        children: children.map((c) => ({ ...c, selected: selectedIds.has(c.objectId) })),
      });
    }

    if (action === "discover") {
      if (!config.systemId || !config.viewId || !config.rootDesignation) {
        return NormalSdk.InvokeError("discover requires systemId, viewId, and rootDesignation in config.");
      }
      const points = await runDiscover(
        http, config.baseUrl, token,
        config.systemId, config.viewId,
        config.rootDesignation, sdk
      );
      // Save to selection JSON so poll-values knows about them
      const selPoints = points.map((p) => ({
        objectId: p.attrs.objectId,
        name: p.name,
        designation: p.attrs.designation,
        managedTypeName: p.attrs.managedTypeName,
        propertyName: p.attrs.propertyName,
      }));
      saveSelection(config.baseUrl, selPoints);
      return NormalSdk.InvokeResult({ imported: points.length, file: SELECTION_FILE });
    }

    return NormalSdk.InvokeError(`Unknown action: "${action}". Valid: listViews, expand, discover, saveSelection, loadSelection`);

  } finally {
    heartbeat.stop();
    await logout(http, config.baseUrl, token);
  }
};
