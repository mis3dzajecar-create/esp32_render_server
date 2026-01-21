// websocket_server.js — Relay v1.0 (ESP32 device -> listeners) + HTML control panel
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

// ====== KONFIG (kasnije prebaci u ENV) ======
const ALLOWED_TOKENS = new Set([
  "PSEUDONIM",   // primer: token za dev001
  // "NEKI_DRUGI_TOKEN",
]);

// ===== HIB CONFIG (server memorija po uređaju) =====
// Napomena: RAM-only (restart servera briše). Kasnije: fajl / DB.
const hibConfigByDevice = new Map();

function getDefaultHibConfig() {
  return { keep_awake: 0, wake_interval_sec: 600 };
}
function getHibConfig(deviceId) {
  return hibConfigByDevice.get(deviceId) || getDefaultHibConfig();
}
function setHibConfig(deviceId, keepAwake, wakeIntervalSec) {
  const cfg = {
    keep_awake: keepAwake ? 1 : 0,
    wake_interval_sec: Math.max(10, Number(wakeIntervalSec) || 600),
  };
  hibConfigByDevice.set(deviceId, cfg);
  return cfg;
}

// ====== WS maps ======
const listenersByDevice = new Map(); // deviceId -> Set(ws listeners)
const producerByDevice = new Map();  // deviceId -> ws producer

function addListener(deviceId, ws) {
  if (!listenersByDevice.has(deviceId)) listenersByDevice.set(deviceId, new Set());
  listenersByDevice.get(deviceId).add(ws);
}
function removeListener(deviceId, ws) {
  const set = listenersByDevice.get(deviceId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) listenersByDevice.delete(deviceId);
}
function closeOldProducer(deviceId, newWs) {
  const old = producerByDevice.get(deviceId);
  if (old && old !== newWs) {
    try { old.close(); } catch {}
  }
  producerByDevice.set(deviceId, newWs);
}

// Poruka koju ESP32 očekuje (ws_take_hib_config_update)
function sendHibConfigToDevice(deviceId) {
  const producer = producerByDevice.get(deviceId);
  if (!producer || producer.readyState !== WebSocket.OPEN) return false;

  const cfg = getHibConfig(deviceId);
  const msg = {
    type: "config", // BITNO: firmware očekuje "config"
    keep_awake: cfg.keep_awake,
    wake_interval_sec: cfg.wake_interval_sec
  };

  try {
    producer.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

// ====== HTML UI ======
const htmlPage = `<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8" />
  <title>ESP32 Audio Control Panel</title>
  <style>
    :root {
      --bg: #0b1220;
      --card: rgba(255,255,255,0.06);
      --text: #e8eefc;
      --muted: rgba(232,238,252,0.7);
      --good: #47d18c;
      --bad: #ff6a6a;
      --warn: #ffd36a;
      --border: rgba(255,255,255,0.12);
      --shadow: 0 12px 40px rgba(0,0,0,0.35);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      color: var(--text);
      background:
        radial-gradient(900px 500px at 15% 10%, rgba(106,167,255,0.28), transparent 55%),
        radial-gradient(700px 420px at 85% 15%, rgba(155,123,255,0.22), transparent 55%),
        radial-gradient(900px 500px at 50% 90%, rgba(71,209,140,0.10), transparent 60%),
        var(--bg);
      padding: 28px 16px;
    }
    .wrap { max-width: 980px; margin: 0 auto; }
    .header { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:18px; }
    .title h1 { font-size: 26px; margin: 0 0 6px 0; }
    .title p { margin: 0; color: var(--muted); font-size: 13px; }
    .pill {
      display:inline-flex; align-items:center; gap:8px; padding:10px 12px;
      border:1px solid var(--border); background: rgba(255,255,255,0.05);
      border-radius:999px; box-shadow: var(--shadow); font-size:12px; color: var(--muted);
    }
    .dot { width:10px; height:10px; border-radius:999px; background: var(--warn); box-shadow:0 0 0 4px rgba(255,211,106,0.15); }
    .dot.ok { background: var(--good); box-shadow:0 0 0 4px rgba(71,209,140,0.15); }
    .dot.bad { background: var(--bad); box-shadow:0 0 0 4px rgba(255,106,106,0.15); }

    .grid { display:grid; grid-template-columns: 1.2fr 1fr; gap:16px; }
    @media (max-width: 920px){ .grid{ grid-template-columns:1fr; } }

    .card {
      background: var(--card);
      border:1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .card h2 { margin: 0 0 10px 0; font-size: 16px; }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 14px 0; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 520px){ .row{ grid-template-columns:1fr; } }

    label { display:block; font-size:12px; color: var(--muted); margin-bottom:6px; }
    input[type="text"], input[type="password"], input[type="number"]{
      width:100%; padding: 11px 12px; border-radius:12px;
      border:1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.18);
      color: var(--text); outline:none;
    }
    .btnbar { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    button{
      border:1px solid rgba(255,255,255,0.16);
      background: linear-gradient(135deg, rgba(106,167,255,0.22), rgba(155,123,255,0.18));
      color: var(--text);
      padding: 10px 12px; border-radius:12px; cursor:pointer;
    }
    button.secondary { background: rgba(255,255,255,0.06); }
    .status{
      margin-top: 10px;
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(0,0,0,0.14);
      color: var(--muted);
      white-space: pre-wrap;
    }
    .status.ok { border-color: rgba(71,209,140,0.35); color: rgba(71,209,140,0.95); }
    .status.bad { border-color: rgba(255,106,106,0.35); color: rgba(255,106,106,0.95); }
    .status.warn { border-color: rgba(255,211,106,0.35); color: rgba(255,211,106,0.95); }

    .toggle{
      display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px;
      border:1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.14);
    }
    .toggle input { transform: scale(1.15); }
    .mini { font-size: 12px; color: var(--muted); margin-top: 8px; }
    .footer { margin-top: 14px; color: rgba(232,238,252,0.55); font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">
        <h1>ESP32 Audio Control Panel</h1>
        <p>Device control preko WebSocket/HTTP. Token obavezan za sve promene.</p>
      </div>
      <div class="pill">
        <span id="dot" class="dot"></span>
        <span id="serverState">Server: standby</span>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Identifikacija</h2>
        <p class="sub">Unesi <b>deviceId</b> i <b>token</b>. UI će automatski povući poslednju sačuvanu HIB konfiguraciju sa servera.</p>

        <div class="row">
          <div>
            <label for="devId">Device ID</label>
            <input id="devId" placeholder="npr. dev001" autocomplete="off" />
          </div>
          <div>
            <label for="token">Token</label>
            <input id="token" type="password" placeholder="token" autocomplete="off" />
          </div>
        </div>

        <div class="btnbar">
          <button id="refreshCfgBtn" class="secondary">Refresh HIB config</button>
        </div>

        <div id="idStatus" class="status">Unesi deviceId + token.</div>
      </div>

      <div class="card">
        <h2>HIBERNACIJA</h2>
        <p class="sub">Server pamti poslednju konfiguraciju po uređaju i gura je čim se uređaj javi (wake).</p>

        <div class="row">
          <div>
            <label for="wakeSec">Wake interval (sec)</label>
            <input id="wakeSec" type="number" min="10" step="1" value="600"/>
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="toggle">
              <input id="keepAwake" type="checkbox"/>
              <div>
                <div><b>keep_awake</b> (1 = budan + stream)</div>
                <div class="mini">Ako je 0, uređaj ulazi u deep-sleep po intervalu.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="btnbar">
          <button id="sendHibBtn">Pošalji HIB konfiguraciju</button>
        </div>

        <div id="hibStatus" class="status">Spremno.</div>
      </div>

      <div class="card">
        <h2>Wi-Fi provisioning</h2>
        <p class="sub">Menjanje Wi-Fi kredencijala preko servera (server šalje ws: wifi_set).</p>

        <div class="row">
          <div>
            <label for="ssid">Wi-Fi SSID</label>
            <input id="ssid" type="text" placeholder="SSID"/>
          </div>
          <div>
            <label for="pass">Wi-Fi Password</label>
            <input id="pass" type="password" placeholder="Password"/>
          </div>
        </div>

        <div class="btnbar">
          <button id="sendWifiBtn">Pošalji Wi-Fi</button>
        </div>

        <div id="wifiStatus" class="status">Spremno.</div>
      </div>

      <div class="card">
        <h2>Status</h2>
        <p class="sub">Online status se dobija iz /api/hib_get (da li je device WS producer trenutno konektovan).</p>
        <div id="status" class="status">Čekam...</div>
        <div class="footer">Napomena: “online” znači da je uređaj trenutno povezan na server kao device (producer).</div>
      </div>
    </div>
  </div>

<script>
  const devIdInp = document.getElementById('devId');
  const tokenInp = document.getElementById('token');

  const wakeSecInp = document.getElementById('wakeSec');
  const keepAwakeInp = document.getElementById('keepAwake');

  const sendHibBtn = document.getElementById('sendHibBtn');
  const hibStatus = document.getElementById('hibStatus');

  const ssidInp = document.getElementById('ssid');
  const passInp = document.getElementById('pass');
  const sendWifiBtn = document.getElementById('sendWifiBtn');
  const wifiStatus = document.getElementById('wifiStatus');

  const statusDiv = document.getElementById('status');
  const idStatus = document.getElementById('idStatus');
  const refreshCfgBtn = document.getElementById('refreshCfgBtn');

  const dot = document.getElementById('dot');
  const serverState = document.getElementById('serverState');

  function setPill(online, text) {
    dot.classList.remove('ok','bad');
    if (online === true) dot.classList.add('ok');
    else if (online === false) dot.classList.add('bad');
    serverState.textContent = text;
  }

  function setBox(el, msg, kind) {
    el.classList.remove('ok','bad','warn');
    if (kind) el.classList.add(kind);
    el.textContent = msg;
  }

  function persistIdToken() {
    try {
      localStorage.setItem("last_device_id", devIdInp.value.trim());
      localStorage.setItem("last_token", tokenInp.value.trim());
    } catch {}
  }

  // Restore previous inputs (no hardcoded secrets)
  try {
    const lastDev = localStorage.getItem("last_device_id") || "";
    const lastTok = localStorage.getItem("last_token") || "";
    if (lastDev) devIdInp.value = lastDev;
    if (lastTok) tokenInp.value = lastTok;
  } catch {}

  async function fetchHibConfig() {
    const deviceId = devIdInp.value.trim();
    const token = tokenInp.value.trim();

    if (!deviceId || !token) {
      setBox(idStatus, "Upiši deviceId i token.", "warn");
      setPill(null, "Server: standby");
      return;
    }

    setBox(idStatus, "Učitavam HIB config sa servera...", "warn");

    try {
      const url = "/api/hib_get?deviceId=" + encodeURIComponent(deviceId) +
                  "&token=" + encodeURIComponent(token);

      const resp = await fetch(url, { method: "GET" });

      // Ako slučajno vrati HTML, ovo će pomoći da odmah vidiš problem
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        setBox(idStatus, "Neuspešno: server nije vratio JSON (content-type=" + ct + ")", "bad");
        setPill(false, "Server: route/error");
        return;
      }

      const data = await resp.json();

      if (!resp.ok || !data.ok) {
        setBox(idStatus, "Neuspešno: " + (data.error || ("HTTP " + resp.status)), "bad");
        setPill(false, "Server: auth/error");
        return;
      }

      wakeSecInp.value = data.cfg?.wake_interval_sec ?? 600;
      keepAwakeInp.checked = (Number(data.cfg?.keep_awake) === 1);

      const online = !!data.online;
      setPill(online, online ? ("Device online: " + deviceId) : ("Device offline: " + deviceId));

      setBox(idStatus, "OK. Učitano sa servera. online=" + (online ? "1" : "0"), "ok");
      setBox(statusDiv,
        "deviceId=" + deviceId + "\\n" +
        "online=" + (online ? "1" : "0") + "\\n" +
        "keep_awake=" + (keepAwakeInp.checked ? "1" : "0") + "\\n" +
        "wake_interval_sec=" + wakeSecInp.value,
        online ? "ok" : "warn"
      );
    } catch (e) {
      setBox(idStatus, "Greška: " + e.message, "bad");
      setPill(false, "Server: error");
    }
  }

  // Debounce + ne zovi server dok token nije “dovoljno dug”
  let tDeb;
  function scheduleFetch() {
    persistIdToken();
    const d = devIdInp.value.trim();
    const t = tokenInp.value.trim();

    if (d.length < 3 || t.length < 4) {
      setBox(idStatus, "Upiši deviceId i token.", "warn");
      setPill(null, "Server: standby");
      return;
    }

    clearTimeout(tDeb);
    tDeb = setTimeout(fetchHibConfig, 600);
  }

  devIdInp.addEventListener('input', scheduleFetch);
  tokenInp.addEventListener('input', scheduleFetch);
  refreshCfgBtn.addEventListener('click', fetchHibConfig);

  sendHibBtn.addEventListener('click', async () => {
    const deviceId = devIdInp.value.trim();
    const token = tokenInp.value.trim();
    const wake_interval_sec = Number(wakeSecInp.value);
    const keep_awake = keepAwakeInp.checked ? 1 : 0;

    if (!deviceId || !token) {
      setBox(hibStatus, "Upiši deviceId i token u sekciji Identifikacija.", "warn");
      return;
    }
    if (!Number.isFinite(wake_interval_sec) || wake_interval_sec < 10) {
      setBox(hibStatus, "wake_interval_sec mora biti broj >= 10.", "bad");
      return;
    }

    setBox(hibStatus, "Šaljem HIB konfiguraciju serveru...", "warn");

    try {
      const url = "/api/hib_set?deviceId=" + encodeURIComponent(deviceId) +
                  "&token=" + encodeURIComponent(token);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep_awake, wake_interval_sec })
      });

      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        setBox(hibStatus, "Neuspešno: server nije vratio JSON (content-type=" + ct + ")", "bad");
        return;
      }

      const data = await resp.json();

      if (!resp.ok || !data.ok) {
        setBox(hibStatus, "Neuspešno: " + (data.error || ("HTTP " + resp.status)), "bad");
        return;
      }

      setBox(hibStatus,
        "OK. Sačuvano na serveru. pushed=" + (data.pushed ? "1" : "0") +
        " (online dobija odmah; offline dobija na sledećem wake).",
        "ok");

      fetchHibConfig();
    } catch (e) {
      setBox(hibStatus, "Greška: " + e.message, "bad");
    }
  });

  sendWifiBtn.addEventListener('click', async () => {
    const deviceId = devIdInp.value.trim();
    const token = tokenInp.value.trim();
    const ssid = ssidInp.value.trim();
    const pass = passInp.value;

    if (!deviceId || !token) {
      setBox(wifiStatus, "Upiši deviceId i token u sekciji Identifikacija.", "warn");
      return;
    }
    if (!ssid) {
      setBox(wifiStatus, "SSID je obavezan.", "bad");
      return;
    }

    setBox(wifiStatus, "Šaljem Wi-Fi kredencijale...", "warn");

    try {
      const url = "/api/wifi_set?deviceId=" + encodeURIComponent(deviceId) +
                  "&token=" + encodeURIComponent(token);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, pass, apply: true })
      });

      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        setBox(wifiStatus, "Neuspešno: server nije vratio JSON (content-type=" + ct + ")", "bad");
        return;
      }

      const data = await resp.json();

      if (!resp.ok || !data.ok) {
        setBox(wifiStatus, "Neuspešno: " + (data.error || ("HTTP " + resp.status)), "bad");
        return;
      }

      setBox(wifiStatus, "OK. Wi-Fi set poslat. pushed=" + (data.pushed ? "1" : "0"), "ok");
    } catch (e) {
      setBox(wifiStatus, "Greška: " + e.message, "bad");
    }
  });

  setPill(null, "Server: standby");
  setBox(statusDiv, "Unesi deviceId + token.", "warn");

  // Ako postoje u localStorage, može odmah refresh
  if ((devIdInp.value || "").trim().length >= 3 && (tokenInp.value || "").trim().length >= 4) {
    fetchHibConfig();
  }
</script>
</body>
</html>`;

// ===== HTTP server: HTML + admin API =====
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  // GET /api/hib_get
  if (u.pathname === "/api/hib_get" && req.method === "GET") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const cfg = getHibConfig(deviceId);
    const p = producerByDevice.get(deviceId);
    const online = !!p && p.readyState === WebSocket.OPEN;

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, deviceId, online, cfg }));
    return;
  }

  // POST /api/hib_set
  if (u.pathname === "/api/hib_set" && req.method === "POST") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad_json" }));
        return;
      }

      const keepAwake = Number(payload.keep_awake) ? 1 : 0;
      const wakeSec = Number(payload.wake_interval_sec);

      if (!Number.isFinite(wakeSec) || wakeSec < 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad_wake_interval_sec" }));
        return;
      }

      const cfg = setHibConfig(deviceId, keepAwake, wakeSec);
      const pushed = sendHibConfigToDevice(deviceId);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stored: cfg, pushed }));
    });
    return;
  }

  // POST /api/wifi_set
  if (u.pathname === "/api/wifi_set" && req.method === "POST") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad_json" }));
        return;
      }

      const ssid = String(payload.ssid || "").trim();
      const pass = String(payload.pass || "").trim();
      const apply = payload.apply !== false;

      if (!ssid || !pass) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "missing_ssid_or_pass" }));
        return;
      }

      const producer = producerByDevice.get(deviceId);
      if (!producer || producer.readyState !== WebSocket.OPEN) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "device_not_connected" }));
        return;
      }

      const msg = { type: "wifi_set", ssid, pass, apply: !!apply };

      try {
        producer.send(JSON.stringify(msg));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, pushed: true }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "send_failed" }));
      }
    });
    return;
  }

  // HTML UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlPage);
});

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  if (pathname !== "/ws/device" && pathname !== "/ws/listen") {
    socket.destroy();
    return;
  }

  const deviceId = (u.searchParams.get("deviceId") || "").trim();
  const token = (u.searchParams.get("token") || "").trim();

  if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._role = pathname === "/ws/device" ? "device" : "listen";
    ws._deviceId = deviceId;
    ws._token = token;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const role = ws._role;
  const deviceId = ws._deviceId;

  console.log(`WS connect: role=${role}, deviceId=${deviceId}`);

  if (role === "device") {
    closeOldProducer(deviceId, ws);

    // minimal ACK
    try { ws.send("ACK"); } catch {}

    // push config odmah po connect
    setTimeout(() => {
      const ok = sendHibConfigToDevice(deviceId);
      console.log(`[HIB] push on connect deviceId=${deviceId} ok=${ok ? 1 : 0} cfg=`, getHibConfig(deviceId));
    }, 300);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        try {
          const msg = JSON.parse(text);
          if (msg && msg.type === "wifi_set_ack") {
            console.log(`[WIFI] ACK from ${deviceId}: ok=${msg.ok} ssid=${msg.ssid || ""}`);
          } else {
            console.log(`[DEVICE ${deviceId}] text:`, text);
          }
        } catch {
          console.log(`[DEVICE ${deviceId}] text:`, text);
        }
        return;
      }

      // binary audio 320B
      if (data.length !== 320) return;

      const listeners = listenersByDevice.get(deviceId);
      if (!listeners) return;

      for (const client of listeners) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: true });
        }
      }
    });

    ws.on("close", () => {
      console.log(`device closed: ${deviceId}`);
      if (producerByDevice.get(deviceId) === ws) producerByDevice.delete(deviceId);
    });

  } else {
    addListener(deviceId, ws);
    ws.on("close", () => {
      console.log(`listener closed: ${deviceId}`);
      removeListener(deviceId, ws);
    });
  }

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

// keepalive ping
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.ping(); } catch {}
  });
}, 15000);

server.listen(PORT, () => {
  console.log(`✅ Relay v1.0 server na portu ${PORT}`);
});
