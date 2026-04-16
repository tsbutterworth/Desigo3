const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Constants — must match import-points.js
// ---------------------------------------------------------------------------
const NAMESPACE  = "fe927c12-7f2f-11ee-a65f-af8737c274cc";
const BATCH_SIZE = 500;
const REFRESH_BUFFER_MS    = 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 9 * 60 * 1000;

const SELECTION_FILE = path.resolve(
  process.env.DESIGO_SELECTION_FILE || "/data/desigo-selection.json"
);

const norisHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// ---------------------------------------------------------------------------
// Token cache — two-layer guard prevents the every-other-run 401.
// See import-points.js comments for full explanation.
// ---------------------------------------------------------------------------
let cachedToken  = "";
let tokenExpiresAt = 0;
let lastUsedAt   = 0;

async function getToken(http, config, sdk) {
  const now = Date.now();
  const tokenStillValid   = cachedToken && tokenExpiresAt - now > REFRESH_BUFFER_MS;
  const sessionStillActive = lastUsedAt && now - lastUsedAt < INACTIVITY_TIMEOUT_MS;

  if (tokenStillValid && sessionStillActive) return cachedToken;

  if (cachedToken) {
    try {
      await http.delete(`${config.baseUrl}/token`, {
        headers: { authorization: `Bearer ${cachedToken}` },
        timeout: 10000,
        httpsAgent: norisHttpsAgent,
      });
    } catch (_) {}
    cachedToken = "";
    lastUsedAt  = 0;
  }

  const { data } = await http.post(
    `${config.baseUrl}/token`,
    new URLSearchParams({
      grant_type: "password",
      username: config.username,
      password: config.password,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
      httpsAgent: norisHttpsAgent,
    }
  );

  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  sdk.logEvent(`Authenticated as ${data.user_name} (expires in ${data.expires_in}s)`);
  return cachedToken;
}

async function pingHeartbeat(http, config, token) {
  try {
    await http.get(`${config.baseUrl}/heartbeat`, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 10000,
      httpsAgent: norisHttpsAgent,
    });
  } catch (err) {
    cachedToken = "";
    lastUsedAt  = 0;
    throw new Error(`Heartbeat failed (${err.response?.status ?? err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Selection file
// ---------------------------------------------------------------------------
function loadSelection(sdk) {
  if (!fs.existsSync(SELECTION_FILE)) {
    sdk.logEvent(`No selection file at ${SELECTION_FILE} — run import-points (action=discover) first.`);
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SELECTION_FILE, "utf8"));
    const points = parsed.points || [];
    sdk.logEvent(`Selection: ${points.length} points (saved ${parsed.savedAt || "unknown"})`);
    return points;
  } catch (err) {
    sdk.logEvent(`Failed to parse selection file: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main hook — scheduled every 15 minutes by poll-values.json
// Receives `points` from Normal (hpl:desigocc layer) but uses the selection
// JSON as the authoritative source of what to poll, so only selected points
// are ever queried — not everything in the layer.
// ---------------------------------------------------------------------------

/**
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config, points }) => {
  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("Missing username, password, or baseUrl in configuration.");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/g, "");

  const http = axios;

  // ── Load selection ───────────────────────────────────────────────────────
  const selectedPoints = loadSelection(sdk);
  if (!selectedPoints || selectedPoints.length === 0) {
    sdk.logEvent("Nothing to poll.");
    return;
  }

  // ── Authenticate + heartbeat ─────────────────────────────────────────────
  let token;
  try {
    token = await getToken(http, config, sdk);
  } catch (err) {
    cachedToken = "";
    lastUsedAt  = 0;
    return NormalSdk.InvokeError(`Authentication failed: ${err.response?.data?.Details || err.message}`);
  }

  try {
    await pingHeartbeat(http, config, token);
    sdk.logEvent("Heartbeat OK — session active.");
  } catch (err) {
    sdk.logEvent(err.message + " — re-authenticating…");
    try {
      token = await getToken(http, config, sdk);
    } catch (reAuthErr) {
      return NormalSdk.InvokeError(`Re-auth failed: ${reAuthErr.message}`);
    }
  }

  // ── Build poll targets from selection ────────────────────────────────────
  // objectId in the selection is already the full "ObjectId.PropertyName" key
  // written by import-points. Split it to get the base ID for the /values call.
  const pollTargets = selectedPoints.map((p) => {
    const parts  = p.objectId.split(".");
    const propName = parts.pop();
    const baseId = parts.join(".");
    return { baseId, fullId: p.objectId, propName, name: p.name };
  });

  const uniqueBaseIds = [...new Set(pollTargets.map((t) => t.baseId))];
  const fullIdMap = new Map(pollTargets.map((t) => [t.fullId, t]));

  sdk.logEvent(`Polling ${uniqueBaseIds.length} objects (${selectedPoints.length} points)…`);

  // ── Poll /values in batches ──────────────────────────────────────────────
  let totalUpdates = 0;

  for (let i = 0; i < uniqueBaseIds.length; i += BATCH_SIZE) {
    const batch = uniqueBaseIds.slice(i, i + BATCH_SIZE);

    let values;
    try {
      const resp = await http.post(`${config.baseUrl}/values`, batch, {
        headers: {
          authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
        httpsAgent: norisHttpsAgent,
      });
      values = resp.data;
    } catch (error) {
      if (error.response?.status === 401) {
        cachedToken = "";
        lastUsedAt  = 0;
        sdk.logEvent("401 mid-poll — clearing token, will re-auth next run.");
        return;
      }
      sdk.logEvent(`Error polling batch at offset ${i}: ${error.message}`);
      continue;
    }

    if (!values || values.length === 0) continue;

    const dataPayloads = [];

    for (const item of values) {
      const val = item.Value;
      if (!val || !val.QualityGood) continue;

      const real = parseFloat(val.Value);
      if (isNaN(real)) continue;

      const fullId = item.OriginalObjectOrPropertyId;
      if (!fullIdMap.has(fullId)) continue; // not in our selection

      const uuid = uuidv5(fullId, NAMESPACE);
      dataPayloads.push({
        uuid,
        layer: "hpl:desigocc",
        values: [{ ts: val.Timestamp, real }],
      });
    }

    // Upload to Normal in sub-batches
    const NF_BATCH = 100;
    for (let j = 0; j < dataPayloads.length; j += NF_BATCH) {
      try {
        for (const payload of dataPayloads.slice(j, j + NF_BATCH)) {
          await http.post(
            `http://${process.env.NFURL}/api/v1/point/data`,
            payload,
            { timeout: 10000 }
          );
          totalUpdates++;
        }
      } catch (err) {
        sdk.logEvent(`Error posting data to Normal: ${err.message}`);
      }
    }
  }

  lastUsedAt = Date.now();
  sdk.logEvent(`Poll complete — ${totalUpdates} values updated from ${selectedPoints.length} selected points`);
};
