// websocket_server.js — Relay v2.0 (ESP32 device -> listeners) + HTML control panel (HIB/RTC/REP)
// Kompatibilno sa ESP32-S3 M1: očekuje type:"params", proto_ver:2, mode, wake_interval_sec, P_ssid/P_pass, *_epoch, start/stop_stream, drain_now
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

// ====== KONFIG (kasnije prebaci u ENV) ======
const ALLOWED_TOKENS = new Set([
  "PSEUDONIM",
]);

// ====== PARAMS memorija po uređaju (RAM-only) ======
const paramsByDevice = new Map(); // deviceId -> params
const lastStatusByDevice = new Map(); // deviceId -> last status object

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

function getDefaultParams() {
  return {
    type: "params",
    proto_ver: 2,

    // core
    mode: "HIB",               // "HIB" | "RTC" | "REP"
    wake_interval_sec: 600,

    // primary wifi (programabilan)
    P_ssid: "",
    P_pass: "",

    // rtc sync + schedule (epoch seconds)
    server_time_epoch: 0,
    start_rec_time_epoch: 0,
    stop_rec_time_epoch: 0,

    // impulsne komande (UI klik)
    start_stream: 0,
    stop_stream: 0,
    drain_now: 0,
  };
}

function getParams(deviceId) {
  if (!paramsByDevice.has(deviceId)) paramsByDevice.set(deviceId, getDefaultParams());
  return paramsByDevice.get(deviceId);
}

// Partial merge + sanitization
function setParams(deviceId, patch) {
  const p = getParams(deviceId);

  // sanitize helpers
  const clampWake = (v) => Math.max(10, Number(v) || 600);
  const as01 = (v) => (Number(v) ? 1 : 0);
  const asEpoch = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  const asMode = (v) => {
    const s = String(v || "").toUpperCase();
    if (s === "HIB" || s === "RTC" || s === "REP") return s;
    return p.mode;
  };

  if (patch.mode != null) p.mode = asMode(patch.mode);
  if (patch.wake_interval_sec != null) p.wake_interval_sec = clampWake(patch.wake_interval_sec);

  if (patch.P_ssid != null) p.P_ssid = String(patch.P_ssid || "").trim();
  if (patch.P_pass != null) p.P_pass = String(patch.P_pass || "").trim();

  if (patch.server_time_epoch != null) p.server_time_epoch = asEpoch(patch.server_time_epoch);
  if (patch.start_rec_time_epoch != null) p.start_rec_time_epoch = asEpoch(patch.start_rec_time_epoch);
  if (patch.stop_rec_time_epoch != null) p.stop_rec_time_epoch = asEpoch(patch.stop_rec_time_epoch);

  // impulses
  if (patch.start_stream != null) p.start_stream = as01(patch.start_stream);
  if (patch.stop_stream != null) p.stop_stream = as01(patch.stop_stream);
  if (patch.drain_now != null) p.drain_now = as01(patch.drain_now);

  // keep meta fields stable
  p.type = "params";
  p.proto_ver = 2;

  paramsByDevice.set(deviceId, p);
  return p;
}

// ====== WS maps ======
const listenersByDevice = new Map(); // deviceId -> Set(ws listeners)
const producerByDevice = new Map();  // deviceId -> ws producer (device)

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

// Push params to device, then auto-clear impulses (start/stop/drain)
function pushParamsToDevice(deviceId) {
  const producer = producerByDevice.get(deviceId);
  if (!producer || producer.readyState !== WebSocket.OPEN) return false;

  const p = { ...getParams(deviceId) };

  try {
    producer.send(JSON.stringify(p));

    // auto-clear impulses after successful send
    const hadImpulse = (p.start_stream || p.stop_stream || p.drain_now);
    if (hadImpulse) {
      const cur = getParams(deviceId);
      cur.start_stream = 0;
      cur.stop_stream = 0;
      cur.drain_now = 0;
      paramsByDevice.set(deviceId, cur);
    }
    return true;
  } catch {
    return false;
  }
}

// ====== HTML UI (HIB / RTC / REP) ======
const htmlPage = `<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8" />
  <title>ESP32 Control Panel (v2)</title>
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
      margin: 0; min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      color: var(--text);
      background:
        radial-gradient(900px 500px at 15% 10%, rgba(106,167,255,0.28), transparent 55%),
        radial-gradient(700px 420px at 85% 15%, rgba(155,123,255,0.22), transparent 55%),
        radial-gradient(900px 500px at 50% 90%, rgba(71,209,140,0.10), transparent 60%),
        var(--bg);
      padding: 28px 16px;
    }
    .wrap { max-width: 1100px; margin: 0 auto; }
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
    @media (max-width: 980px){ .grid{ grid-template-columns:1fr; } }

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
    input[type="text"], input[type="password"], input[type="number"], input[type="datetime-local"], select{
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
    button.danger { background: rgba(255,106,106,0.14); }
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
    .mini { font-size: 12px; color: var(--muted); margin-top: 8px; }
    .footer { margin-top: 14px; color: rgba(232,238,252,0.55); font-size: 12px; }
    .sep { height:1px; background: rgba(255,255,255,0.12); margin: 14px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">
        <h1>ESP32 Control Panel (v2)</h1>
        <p>HIB / RTC / REP kontrola + Primary Wi-Fi + Drain. Token obavezan.</p>
      </div>
      <div class="pill">
        <span id="dot" class="dot"></span>
        <span id="serverState">Server: standby</span>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Identifikacija</h2>
        <p class="sub">Unesi <b>deviceId</b> i <b>token</b>. UI radi preko /api/params_get i /api/params_set.</p>

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
          <button id="refreshBtn" class="secondary">Refresh</button>
          <button id="syncTimeBtn" class="secondary">Sync server_time_epoch = now</button>
        </div>

        <div id="idStatus" class="status">Unesi deviceId + token.</div>

        <div class="sep"></div>

        <h2>GLOBAL</h2>
        <p class="sub">Ovo se šalje u svakoj params poruci.</p>

        <div class="row">
          <div>
            <label for="mode">Mode</label>
            <select id="mode">
              <option value="HIB">HIB</option>
              <option value="RTC">RTC</option>
              <option value="REP">REP</option>
            </select>
          </div>
          <div>
            <label for="wakeSec">wake_interval_sec</label>
            <input id="wakeSec" type="number" min="10" step="1" value="600"/>
          </div>
        </div>

        <div class="btnbar">
          <button id="sendGlobalBtn">Pošalji GLOBAL (mode + wake)</button>
        </div>

        <div id="globalStatus" class="status">Spremno.</div>

        <div class="sep"></div>

        <h2>Primary Wi-Fi (P_ssid / P_pass)</h2>
        <p class="sub">Ovo ide u params i ESP ga upisuje u NVS.</p>

        <div class="row">
          <div>
            <label for="pssid">P_ssid</label>
            <input id="pssid" type="text" placeholder="SSID"/>
          </div>
          <div>
            <label for="ppass">P_pass</label>
            <input id="ppass" type="password" placeholder="Password"/>
          </div>
        </div>

        <div class="btnbar">
          <button id="sendWifiBtn">Pošalji Primary Wi-Fi</button>
        </div>

        <div id="wifiStatus" class="status">Spremno.</div>
      </div>

      <div class="card">
        <h2>HIB</h2>
        <p class="sub">U HIB modu uređaj se javlja, primi params i spava.</p>
        <div class="btnbar">
          <button id="setHIBBtn" class="secondary">Postavi mode=HIB</button>
          <button id="drainBtn">Drain now</button>
        </div>

        <div class="sep"></div>

        <h2>RTC</h2>
        <p class="sub">Podesi start/stop snimanja (datetime-local). Konvertuje se u epoch seconds.</p>
        <div class="row">
          <div>
            <label for="rtcStart">start_rec_time</label>
            <input id="rtcStart" type="datetime-local"/>
          </div>
          <div>
            <label for="rtcStop">stop_rec_time</label>
            <input id="rtcStop" type="datetime-local"/>
          </div>
        </div>
        <div class="btnbar">
          <button id="sendRtcBtn">Pošalji RTC (start/stop)</button>
          <button id="setRTCBtn" class="secondary">Postavi mode=RTC</button>
        </div>
        <div id="rtcStatus" class="status">Spremno.</div>

        <div class="sep"></div>

        <h2>REP</h2>
        <p class="sub">Live stream komande (impuls). Uređaj streamuje kad je mode=REP i dobije start_stream=1.</p>
        <div class="btnbar">
          <button id="setREPBtn" class="secondary">Postavi mode=REP</button>
          <button id="startStreamBtn">Start stream</button>
          <button id="stopStreamBtn" class="danger">Stop stream</button>
        </div>
        <div id="repStatus" class="status">Spremno.</div>

        <div class="sep"></div>

        <h2>Status (poslednji status od uređaja)</h2>
        <p class="sub">Ovo server pamti kad device pošalje type="status".</p>
        <div id="statusBox" class="status">Čekam...</div>
        <div class="footer">Online znači: WS producer konektovan.</div>
      </div>
    </div>
  </div>

<script>
  const devIdInp = document.getElementById('devId');
  const tokenInp = document.getElementById('token');

  const refreshBtn = document.getElementById('refreshBtn');
  const syncTimeBtn = document.getElementById('syncTimeBtn');

  const modeSel = document.getElementById('mode');
  const wakeSecInp = document.getElementById('wakeSec');
  const sendGlobalBtn = document.getElementById('sendGlobalBtn');
  const globalStatus = document.getElementById('globalStatus');

  const pssidInp = document.getElementById('pssid');
  const ppassInp = document.getElementById('ppass');
  const sendWifiBtn = document.getElementById('sendWifiBtn');
  const wifiStatus = document.getElementById('wifiStatus');

  const setHIBBtn = document.getElementById('setHIBBtn');
  const drainBtn = document.getElementById('drainBtn');

  const rtcStartInp = document.getElementById('rtcStart');
  const rtcStopInp  = document.getElementById('rtcStop');
  const sendRtcBtn  = document.getElementById('sendRtcBtn');
  const setRTCBtn   = document.getElementById('setRTCBtn');
  const rtcStatus   = document.getElementById('rtcStatus');

  const setREPBtn = document.getElementById('setREPBtn');
  const startStreamBtn = document.getElementById('startStreamBtn');
  const stopStreamBtn  = document.getElementById('stopStreamBtn');
  const repStatus = document.getElementById('repStatus');

  const statusBox = document.getElementById('statusBox');
  const idStatus = document.getElementById('idStatus');

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

  // restore
  try {
    const lastDev = localStorage.getItem("last_device_id") || "";
    const lastTok = localStorage.getItem("last_token") || "";
    if (lastDev) devIdInp.value = lastDev;
    if (lastTok) tokenInp.value = lastTok;
  } catch {}

  function authOk() {
    const d = devIdInp.value.trim();
    const t = tokenInp.value.trim();
    return (d.length >= 3 && t.length >= 4);
  }

  function apiUrl(path) {
    const deviceId = devIdInp.value.trim();
    const token = tokenInp.value.trim();
    return path + "?deviceId=" + encodeURIComponent(deviceId) + "&token=" + encodeURIComponent(token);
  }

  function dtLocalToEpochSec(v) {
    // v: "YYYY-MM-DDTHH:MM"
    if (!v) return 0;
    const d = new Date(v);
    if (isNaN(d.getTime())) return 0;
    return Math.floor(d.getTime() / 1000);
  }

  function epochToDtLocal(epoch) {
    if (!epoch || !Number.isFinite(epoch)) return "";
    const d = new Date(epoch * 1000);
    const pad = (n) => String(n).padStart(2,"0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth()+1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return \`\${yyyy}-\${mm}-\${dd}T\${hh}:\${mi}\`;
  }

  async function fetchParams() {
    if (!authOk()) {
      setBox(idStatus, "Upiši deviceId i token.", "warn");
      setPill(null, "Server: standby");
      return;
    }

    setBox(idStatus, "Učitavam params sa servera...", "warn");
    try {
      const resp = await fetch(apiUrl("/api/params_get"), { method: "GET" });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        setBox(idStatus, "Server nije vratio JSON (ct=" + ct + ")", "bad");
        setPill(false, "Server: route/error");
        return;
      }
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setBox(idStatus, "Neuspešno: " + (data.error || ("HTTP " + resp.status)), "bad");
        setPill(false, "Server: auth/error");
        return;
      }

      const p = data.params || {};
      modeSel.value = p.mode || "HIB";
      wakeSecInp.value = p.wake_interval_sec ?? 600;

      pssidInp.value = p.P_ssid || "";
      ppassInp.value = p.P_pass || "";

      rtcStartInp.value = epochToDtLocal(Number(p.start_rec_time_epoch||0));
      rtcStopInp.value  = epochToDtLocal(Number(p.stop_rec_time_epoch||0));

      const online = !!data.online;
      setPill(online, online ? ("Device online: " + data.deviceId) : ("Device offline: " + data.deviceId));
      setBox(idStatus, "OK. online=" + (online?1:0), online ? "ok" : "warn");

      const st = data.lastStatus || null;
      if (!st) {
        setBox(statusBox, "Nema status-a još (device nije poslao type=status).", online ? "warn" : "warn");
      } else {
        setBox(statusBox,
          "uptime_s=" + (st.uptime_s ?? "?") + "\\n" +
          "wifi_ok=" + (st.wifi_ok ?? "?") + " rssi=" + (st.wifi_rssi ?? "?") + "\\n" +
          "queue_files=" + (st.queue_files ?? 0) + " queue_bytes=" + (st.queue_bytes ?? 0) + "\\n" +
          "oldest_file_epoch=" + (st.oldest_file_epoch ?? 0) + "\\n" +
          "streaming=" + (st.streaming ?? 0) + " recording=" + (st.recording ?? 0),
          online ? "ok" : "warn"
        );
      }
    } catch (e) {
      setBox(idStatus, "Greška: " + e.message, "bad");
      setPill(false, "Server: error");
    }
  }

  async function postParams(patch, statusEl) {
    if (!authOk()) {
      setBox(statusEl, "Upiši deviceId i token.", "warn");
      return;
    }
    setBox(statusEl, "Šaljem...", "warn");

    try {
      const resp = await fetch(apiUrl("/api/params_set"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {})
      });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        setBox(statusEl, "Server nije vratio JSON (ct=" + ct + ")", "bad");
        return;
      }
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setBox(statusEl, "Neuspešno: " + (data.error || ("HTTP " + resp.status)), "bad");
        return;
      }
      setBox(statusEl, "OK. pushed=" + (data.pushed?1:0), data.pushed ? "ok" : "warn");
      fetchParams();
    } catch (e) {
      setBox(statusEl, "Greška: " + e.message, "bad");
    }
  }

  // events
  function scheduleFetch() {
    persistIdToken();
    if (!authOk()) return;
    clearTimeout(window._deb);
    window._deb = setTimeout(fetchParams, 400);
  }

  devIdInp.addEventListener('input', scheduleFetch);
  tokenInp.addEventListener('input', scheduleFetch);
  refreshBtn.addEventListener('click', fetchParams);

  syncTimeBtn.addEventListener('click', () => {
    postParams({ server_time_epoch: Math.floor(Date.now()/1000) }, idStatus);
  });

  sendGlobalBtn.addEventListener('click', () => {
    const wake_interval_sec = Number(wakeSecInp.value);
    postParams({ mode: modeSel.value, wake_interval_sec }, globalStatus);
  });

  sendWifiBtn.addEventListener('click', () => {
    postParams({ P_ssid: pssidInp.value.trim(), P_pass: ppassInp.value }, wifiStatus);
  });

  setHIBBtn.addEventListener('click', () => postParams({ mode:"HIB" }, globalStatus));
  drainBtn.addEventListener('click', () => postParams({ drain_now: 1 }, globalStatus));

  sendRtcBtn.addEventListener('click', () => {
    const start_rec_time_epoch = dtLocalToEpochSec(rtcStartInp.value);
    const stop_rec_time_epoch  = dtLocalToEpochSec(rtcStopInp.value);
    postParams({ start_rec_time_epoch, stop_rec_time_epoch }, rtcStatus);
  });
  setRTCBtn.addEventListener('click', () => postParams({ mode:"RTC" }, rtcStatus));

  setREPBtn.addEventListener('click', () => postParams({ mode:"REP" }, repStatus));
  startStreamBtn.addEventListener('click', () => postParams({ start_stream: 1 }, repStatus));
  stopStreamBtn.addEventListener('click', () => postParams({ stop_stream: 1 }, repStatus));

  setPill(null, "Server: standby");
  setBox(statusBox, "Unesi deviceId + token.", "warn");

  if ((devIdInp.value || "").trim().length >= 3 && (tokenInp.value || "").trim().length >= 4) {
    fetchParams();
  }
</script>
</body>
</html>`;

const playerPage = `<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8" />
  <title>ESP32 Audio Player</title>
  <style>
    body { font-family: system-ui, Arial; background:#0b1220; color:#e8eefc; margin:0; padding:24px; }
    .card { max-width:760px; margin:0 auto; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
            border-radius:14px; padding:16px; }
    input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,0.14);
            background:rgba(0,0,0,0.18); color:#e8eefc; margin-top:6px; }
    label { display:block; margin-top:10px; color:rgba(232,238,252,0.75); font-size:12px; }
    button { margin-top:12px; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,0.16);
             background:rgba(106,167,255,0.22); color:#e8eefc; cursor:pointer; }
    .log { margin-top:12px; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,0.12);
           background:rgba(0,0,0,0.15); white-space:pre-wrap; color:rgba(232,238,252,0.85); font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Audio Player (PCM16LE 8kHz, 20ms frames)</h2>
    <p>Morate kliknuti Start (zbog browser audio policy).</p>

    <label>deviceId</label>
    <input id="devId" placeholder="dev001" />

    <label>token</label>
    <input id="token" type="password" placeholder="token" />

    <button id="btn">Start listening</button>
    <button id="stop">Stop</button>

    <div id="log" class="log">Idle.</div>
  </div>

<script>
  const devId = document.getElementById('devId');
  const token = document.getElementById('token');
  const btn = document.getElementById('btn');
  const stopBtn = document.getElementById('stop');
  const log = document.getElementById('log');

  function setLog(s){ log.textContent = s; }

  try {
    devId.value = localStorage.getItem("p_devId") || "";
    token.value = localStorage.getItem("p_token") || "";
  } catch {}

  let ws = null;
  let ctx = null;
  let nextPlayTime = 0;

  const IN_SR = 8000;
  const FRAME_SAMPLES = 160;
  const FRAME_BYTES = 320;

  async function ensureAudio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== "running") await ctx.resume();
    if (nextPlayTime < ctx.currentTime) nextPlayTime = ctx.currentTime + 0.05; // mali lead
  }

  function pcm16leToFloat32(ab) {
    const view = new DataView(ab);
    const out = new Float32Array(FRAME_SAMPLES);
    for (let i=0; i<FRAME_SAMPLES; i++) {
      const v = view.getInt16(i*2, true);
      out[i] = v / 32768;
    }
    return out;
  }

  // Linear upsample (8k -> ctx.sampleRate)
  function resampleLinear(inFloats, inRate, outRate) {
    if (inRate === outRate) return inFloats;

    const ratio = outRate / inRate;
    const outLen = Math.max(1, Math.round(inFloats.length * ratio));
    const out = new Float32Array(outLen);

    for (let i=0; i<outLen; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, inFloats.length - 1);
      const t = srcPos - i0;
      out[i] = inFloats[i0] * (1 - t) + inFloats[i1] * t;
    }
    return out;
  }

  function scheduleChunk(floatData) {
    if (!ctx) return;

    // resample na output sampleRate
    const out = resampleLinear(floatData, IN_SR, ctx.sampleRate);

    const buf = ctx.createBuffer(1, out.length, ctx.sampleRate);
    buf.getChannelData(0).set(out);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    if (nextPlayTime < now + 0.02) nextPlayTime = now + 0.02;

    src.start(nextPlayTime);
    nextPlayTime += out.length / ctx.sampleRate;
  }

  async function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (data instanceof Blob) return await data.arrayBuffer();
    return null;
  }

  btn.onclick = async () => {
    const d = devId.value.trim();
    const t = token.value.trim();
    if (!d || !t) { setLog("Unesi deviceId + token."); return; }

    try {
      localStorage.setItem("p_devId", d);
      localStorage.setItem("p_token", t);
    } catch {}

    await ensureAudio();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = proto + "://" + location.host + "/ws/listen?deviceId=" +
                encodeURIComponent(d) + "&token=" + encodeURIComponent(t);

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer"; // i dalje ostavi

    ws.onopen = () => setLog("WS listen connected. Waiting audio...");
    ws.onclose = () => setLog("WS closed.");
    ws.onerror = () => setLog("WS error.");

    ws.onmessage = async (ev) => {
      const ab = await toArrayBuffer(ev.data);
      if (!ab) return;
      if (ab.byteLength !== FRAME_BYTES) return;
      setLog("Receiving 320B frames... t=" + new Date().toLocaleTimeString());


      // osiguraj da je audio context živ (ponekad suspenduje)
      if (ctx && ctx.state !== "running") { try { await ctx.resume(); } catch {} }

      const f = pcm16leToFloat32(ab);
      scheduleChunk(f);
    };
  };

  stopBtn.onclick = () => {
    try { if (ws) ws.close(); } catch {}
    ws = null;
    nextPlayTime = 0;
    if (ctx) { try { ctx.suspend(); } catch {} }
    setLog("Stopped.");
  };
</script>
</body>
</html>`;

// ===== HTTP server: HTML + admin API =====
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/player" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(playerPage);
    return;
  }

  // GET /api/params_get
  if (u.pathname === "/api/params_get" && req.method === "GET") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const p = producerByDevice.get(deviceId);
    const online = !!p && p.readyState === WebSocket.OPEN;

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      deviceId,
      online,
      params: getParams(deviceId),
      lastStatus: lastStatusByDevice.get(deviceId) || null
    }));
    return;
  }

  // POST /api/params_set
  if (u.pathname === "/api/params_set" && req.method === "POST") {
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
      let patch;
      try { patch = JSON.parse(body || "{}"); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad_json" }));
        return;
      }

      const stored = setParams(deviceId, patch);

      // optional: auto set server_time_epoch if requested via patch.sync_now
      if (patch && patch.sync_now) {
        stored.server_time_epoch = nowEpochSec();
      }

      const pushed = pushParamsToDevice(deviceId);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stored, pushed }));
    });
    return;
  }

  // Backward compatibility routes (optional):
  // GET /api/hib_get -> maps to params_get (returns subset)
  if (u.pathname === "/api/hib_get" && req.method === "GET") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const p = producerByDevice.get(deviceId);
    const online = !!p && p.readyState === WebSocket.OPEN;

    // keep old shape for older UI/scripts
    const params = getParams(deviceId);
    const cfg = {
      keep_awake: params.mode === "REP" ? 1 : 0, // legacy mapping
      wake_interval_sec: params.wake_interval_sec
    };

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, deviceId, online, cfg }));
    return;
  }

  // POST /api/hib_set -> maps keep_awake->mode + wake_interval_sec
  if (u.pathname === "/api/hib_set" && req.method === "POST") {
    const deviceId = (u.searchParams.get("deviceId") || "").trim();
    const token = (u.searchParams.get("token") || "").trim();

    if (!deviceId || !token || !ALLOWED_TOKENS.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSONate.stringify({ ok: false, error: "unauthorized" }));
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

      const stored = setParams(deviceId, {
        mode: keepAwake ? "REP" : "HIB",
        wake_interval_sec: wakeSec
      });
      const pushed = pushParamsToDevice(deviceId);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stored, pushed }));
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

    // JSON ACK (umesto "ACK" len=3)
    try { ws.send(JSON.stringify({ type: "ack", proto_ver: 2 })); } catch {}

    // push params odmah po connect
    setTimeout(() => {
      // ako nema server_time_epoch, inicijalno ga postavi na "now" (ne forsira device, samo nudi)
      const p = getParams(deviceId);
      if (!p.server_time_epoch) {
        p.server_time_epoch = nowEpochSec();
        paramsByDevice.set(deviceId, p);
      }
      const ok = pushParamsToDevice(deviceId);
      console.log(`[PARAMS] push on connect deviceId=${deviceId} ok=${ok ? 1 : 0}`, getParams(deviceId));
    }, 250);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();

        // Ako device šalje status, sačuvaj i vrati params odmah (control loop)
        try {
          const msg = JSON.parse(text);

          if (msg && msg.type === "status") {
            lastStatusByDevice.set(deviceId, msg);

            // server može ažurirati server_time_epoch po status-u (opciono, v2: držimo ga stabilnim dok user ne sync)
            // ali možemo i osvežavati uvek:
            // const p = getParams(deviceId); p.server_time_epoch = nowEpochSec(); paramsByDevice.set(deviceId,p);

            // uvek vrati params (najbitnije za M1/M5)
            pushParamsToDevice(deviceId);
            return;
          }

          console.log(`[DEVICE ${deviceId}] text:`, msg);
        } catch {
          console.log(`[DEVICE ${deviceId}] text:`, text);
        }
        return;
      }

      // binary audio 320B (REP live stream)
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
  console.log(`✅ Relay v2.0 server na portu ${PORT}`);
});
