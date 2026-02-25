// server.js — ESP32 Video Relay v0.2 (device publish -> viewers) + limit 5
// Endpoints:
//   /ws/device?deviceId=cam001&token=DEVICE_TOKEN
//   /ws/view?deviceId=cam001&token=VIEWER_TOKEN

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { URL } = require("url");
const path = require("path");

const PORT = process.env.PORT || 10000;

// ====== STREAM PROFILE (zakucano) ======
const STREAM_RES = "VGA";     // for now informational
const STREAM_FPS = 5;         // zakucano
const VIEWER_LIMIT = 5;

// ====== TOKENS (ENV) ======
// Opcija 1 (preporuka za start): comma-separated
// DEVICE_TOKENS="cam001:DEV_TOKEN_1,cam002:DEV_TOKEN_2"
// VIEWER_TOKENS="VIEW1,VIEW2,VIEW3" (ili samo jedan token koji deliš ti)
const DEVICE_TOKENS_RAW = process.env.DEVICE_TOKENS || "";
const VIEWER_TOKENS_RAW = process.env.VIEWER_TOKENS || "";

// Parsiranje "cam001:token,cam002:token"
function parseDeviceTokens(raw) {
  const map = new Map();
  raw.split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const idx = pair.indexOf(":");
    if (idx <= 0) return;
    const deviceId = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (deviceId && token) map.set(deviceId, token);
  });
  return map;
}

// Parsiranje viewer tokena "t1,t2,t3"
function parseViewerTokens(raw) {
  const set = new Set();
  raw.split(",").map(s => s.trim()).filter(Boolean).forEach(t => set.add(t));
  return set;
}

const DEVICE_TOKENS = parseDeviceTokens(DEVICE_TOKENS_RAW);
const VIEWER_TOKENS = parseViewerTokens(VIEWER_TOKENS_RAW);

// ====== STATE ======
/** deviceId -> WebSocket */
const devices = new Map();
/** deviceId -> Set<WebSocket> */
const viewers = new Map();
/** deviceId -> boolean streaming started */
const streaming = new Map();

function getViewerSet(deviceId) {
  if (!viewers.has(deviceId)) viewers.set(deviceId, new Set());
  return viewers.get(deviceId);
}

function sendJson(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function closeWithError(ws, reason) {
  try { sendJson(ws, { type: "ERROR", reason }); } catch {}
  try { ws.close(1008, reason); } catch {}
}

function isValidDeviceToken(deviceId, token) {
  // Ako nema mapiranja, odbijamo (sigurnije).
  const expected = DEVICE_TOKENS.get(deviceId);
  return !!expected && token === expected;
}

function isValidViewerToken(token) {
  // Ako nisi setovao VIEWER_TOKENS, nemoj slučajno otvoriti svima:
  // striktno: mora postojati bar 1 token
  if (VIEWER_TOKENS.size === 0) return false;
  return VIEWER_TOKENS.has(token);
}

function startStreamIfNeeded(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev || dev.readyState !== dev.OPEN) return;

  const set = getViewerSet(deviceId);
  if (set.size > 0 && !streaming.get(deviceId)) {
    streaming.set(deviceId, true);
    sendJson(dev, { type: "START_STREAM", res: STREAM_RES, fps: STREAM_FPS });
    console.log(`[STREAM] START_STREAM -> ${deviceId} (viewers=${set.size})`);
  }
}

function stopStreamIfNeeded(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev || dev.readyState !== dev.OPEN) return;

  const set = getViewerSet(deviceId);
  if (set.size === 0 && streaming.get(deviceId)) {
    streaming.set(deviceId, false);
    sendJson(dev, { type: "STOP_STREAM" });
    console.log(`[STREAM] STOP_STREAM -> ${deviceId} (viewers=0)`);
  }
}

// ====== HTTP + WS UPGRADE ROUTING ======
const app = express();
app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "viewer.html"));
});
app.get("/", (req, res) => {
  res.type("text/plain").send("ESP32 Video WS Relay v0.2 OK");
});
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    devices: Array.from(devices.keys()),
    viewers: Array.from(viewers.entries()).reduce((acc, [id, set]) => {
      acc[id] = set.size;
      return acc;
    }, {})
  });
});

const server = http.createServer(app);

// Kreiramo 2 WebSocketServer instance, obe koriste isti HTTP server (upgrade)
const wssDevice = new WebSocketServer({ noServer: true });
const wssView = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/ws/device") {
      wssDevice.handleUpgrade(req, socket, head, (ws) => {
        wssDevice.emit("connection", ws, req, url);
      });
      return;
    }

    if (path === "/ws/view") {
      wssView.handleUpgrade(req, socket, head, (ws) => {
        wssView.emit("connection", ws, req, url);
      });
      return;
    }

    socket.destroy();
  } catch (e) {
    socket.destroy();
  }
});

// ====== DEVICE CONNECTION HANDLER ======
wssDevice.on("connection", (ws, req, url) => {
  const deviceId = url.searchParams.get("deviceId") || "";
  const token = url.searchParams.get("token") || "";

  if (!deviceId || !isValidDeviceToken(deviceId, token)) {
    console.log(`[DEV] reject deviceId=${deviceId} invalid token`);
    return closeWithError(ws, "UNAUTHORIZED");
  }

  // Ako postoji stari device socket za isti deviceId, zatvori ga (preuzimanje)
  const prev = devices.get(deviceId);
  if (prev && prev !== ws) {
    try { prev.close(1012, "Replaced by new connection"); } catch {}
  }

  devices.set(deviceId, ws);
  streaming.set(deviceId, false);

  console.log(`[DEV] connected deviceId=${deviceId}`);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      // tekst poruke (HELLO, log, itd.)
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "HELLO") {
          console.log(`[DEV] HELLO ${deviceId} fw=${msg.fw || "?"}`);
        }
      } catch {}
      return;
    }

    // Binary FRAME: prosledi svim viewerima za taj deviceId
    const set = getViewerSet(deviceId);
    if (set.size === 0) return; // nema koga da gleda

    for (const v of set) {
      if (v.readyState === v.OPEN) {
        try { v.send(data, { binary: true }); } catch {}
      }
    }
  });

  ws.on("close", () => {
    console.log(`[DEV] disconnected deviceId=${deviceId}`);
    const cur = devices.get(deviceId);
    if (cur === ws) devices.delete(deviceId);
    streaming.set(deviceId, false);
  });

  ws.on("error", (e) => {
    console.log(`[DEV] error deviceId=${deviceId}`, e?.message || e);
  });

  // Ako viewer već postoji (npr. viewer se povezao pre device-a), startuj stream
  startStreamIfNeeded(deviceId);
});

// ====== VIEWER CONNECTION HANDLER ======
wssView.on("connection", (ws, req, url) => {
  const deviceId = url.searchParams.get("deviceId") || "";
  const token = url.searchParams.get("token") || "";

  if (!deviceId || !isValidViewerToken(token)) {
    console.log(`[VIEW] reject deviceId=${deviceId} invalid token`);
    return closeWithError(ws, "UNAUTHORIZED");
  }

  const set = getViewerSet(deviceId);

  if (set.size >= VIEWER_LIMIT) {
    console.log(`[VIEW] limit reached deviceId=${deviceId} viewers=${set.size}`);
    return closeWithError(ws, "LIMIT_REACHED");
  }

  set.add(ws);
  console.log(`[VIEW] connected deviceId=${deviceId} viewers=${set.size}`);

  // Kad se pojavi prvi viewer, tražimo da device krene stream
  startStreamIfNeeded(deviceId);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // viewer ne šalje binary

    try {
      const msg = JSON.parse(data.toString("utf8"));

      if (msg?.type === "REQ_HQ_SNAPSHOT") {
        const dev = devices.get(deviceId);
        if (dev && dev.readyState === dev.OPEN) {
          // Prosledi komandu device-u. (Uređaj treba da pošalje 1 HQ frame)
          sendJson(dev, { type: "SNAPSHOT_HQ" });
          // Opcionalno: možeš poslati ack vieweru
          // sendJson(ws, { type: "ACK", what: "SNAPSHOT_HQ" });
          console.log(`[HQ] request from viewer -> deviceId=${deviceId}`);
        } else {
          sendJson(ws, { type: "ERROR", reason: "DEVICE_OFFLINE" });
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    set.delete(ws);
    console.log(`[VIEW] disconnected deviceId=${deviceId} viewers=${set.size}`);
    // Kad nema više viewera, možemo stop stream
    stopStreamIfNeeded(deviceId);
  });

  ws.on("error", (e) => {
    console.log(`[VIEW] error deviceId=${deviceId}`, e?.message || e);
  });
});

server.listen(PORT, () => {
  console.log(`Video WS Relay v0.2 listening on :${PORT}`);
  console.log(`Configured devices: ${Array.from(DEVICE_TOKENS.keys()).join(", ") || "(none)"}`);
  console.log(`Viewer tokens: ${VIEWER_TOKENS.size}`);
});