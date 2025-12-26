// websocket_server.js — Relay v1.0 (ESP32 device -> listeners) + HTML player
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

// ====== KONFIG (kasnije prebaci u ENV) ======
const ALLOWED_TOKENS = new Set([
  "PSEUDONIM",   // primer: token za dev001
  // "NEKI_DRUGI_TOKEN",
]);

// ====== HTML (minimalno) ======
// Važno: naš ugovor je 8 kHz, PCM16 mono.
// Browser AudioContext ponekad ignoriše sampleRate, ali mi svakako postavljamo 8000.
const htmlPage = `
<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8" />
  <title> Audio Stream (v1.0)</title>
  <style>
    body { font-family: sans-serif; text-align: center; margin-top: 40px; }
    h1 { font-size: 26px; }
    #status { margin-top: 10px; font-size: 14px; color: #555; }
    button { padding: 10px 20px; font-size: 16px; margin-top: 20px; }
    input { padding: 8px; width: 260px; }
  </style>
</head>
<body>
  <h1>ESP32 Audio Live Stream</h1>

  <p>Device ID:</p>
  <input id="devId" placeholder="Upiši deviceId" />

  <p>Token:</p>
  <input id="token" placeholder="Upiši token" /> 


  <div style="margin-top: 15px;">
    <button id="startBtn">Start audio</button>
  </div>
    <hr style="margin:30px auto; width: 360px;">

  <h3>WiFi Provision (remote)</h3>

  <p>Novi SSID:</p>
  <input id="newSsid" placeholder="npr. KOMSIJA_WIFI" />

  <p>Novi Password:</p>
  <input id="newPass" placeholder="npr. 12345678" />

  <div style="margin-top: 15px;">
    <button id="sendWifiBtn">Pošalji WiFi kredencije</button>
  </div>

  <div id="wifiStatus" style="margin-top:10px; font-size:13px; color:#333;"></div>


  <div id="status">Čekam konekciju...</div>

  <script>
    const statusDiv = document.getElementById('status');
    const startBtn  = document.getElementById('startBtn');
    const devIdInp  = document.getElementById('devId');
    const tokenInp  = document.getElementById('token');
    const newSsidInp = document.getElementById('newSsid');
    const newPassInp = document.getElementById('newPass');
    const wifiStatus = document.getElementById('wifiStatus');
    const sendWifiBtn = document.getElementById('sendWifiBtn');


    let ws = null;

    let audioCtx = null;
    let scriptNode = null;
    let audioBuffer = [];
    let bufferOffset = 0;

    function queueAudio(int16Samples) {
      audioBuffer.push(int16Samples);
    }

    function initAudio() {
      if (audioCtx) return;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 8000
      });

      scriptNode = audioCtx.createScriptProcessor(1024, 0, 1);
      scriptNode.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) {
          if (audioBuffer.length === 0) {
            out[i] = 0;
            continue;
          }
          let current = audioBuffer[0];
          if (bufferOffset >= current.length) {
            audioBuffer.shift();
            bufferOffset = 0;
            if (audioBuffer.length === 0) {
              out[i] = 0;
              continue;
            }
            current = audioBuffer[0];
          }
          out[i] = current[bufferOffset++] / 32768;
        }
      };

      scriptNode.connect(audioCtx.destination);
      audioCtx.resume();
    }

    function connectWS() {
      const deviceId = encodeURIComponent(devIdInp.value.trim());
      const token    = encodeURIComponent(tokenInp.value.trim());

      const proto = (location.protocol === 'https:' ? 'wss://' : 'ws://');
      const url = proto + location.host + '/ws/listen?deviceId=' + deviceId + '&token=' + token;

      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => statusDiv.textContent = 'WS povezan (čekam audio)...';
      ws.onclose = () => statusDiv.textContent = 'Veza zatvorena';
      ws.onerror = () => statusDiv.textContent = 'Greška na WS vezi';

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') return;
        const samples = new Int16Array(event.data);
        queueAudio(samples);
      };
    }

    startBtn.addEventListener('click', async () => {
  const deviceId = devIdInp.value.trim();
  const token = tokenInp.value.trim();

  if (!deviceId) {
    statusDiv.textContent = "Upiši deviceID pre startovanja";
    return;
  }
  if (!token) {
    statusDiv.textContent = "Upiši token pre startovanja";
    return;
  }

  initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  connectWS();
  startBtn.disabled = true;
  startBtn.textContent = 'Audio radi';
  statusDiv.textContent = 'Povezujem...';
});
sendWifiBtn.addEventListener('click', async () => {
  const deviceId = devIdInp.value.trim();
  const token = tokenInp.value.trim();
  const ssid = newSsidInp.value.trim();
  const pass = newPassInp.value.trim();

  if (!deviceId || !token) {
    wifiStatus.textContent = "Upiši deviceId i token iznad.";
    return;
  }
  if (!ssid || !pass) {
    wifiStatus.textContent = "Upiši novi SSID i password.";
    return;
  }

  wifiStatus.textContent = "Šaljem kredencije serveru...";

  try {
    const resp = await fetch(`/api/wifi_set?deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid, pass, apply: true })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      wifiStatus.textContent = "Neuspešno: " + (data.error || ("HTTP " + resp.status));
      return;
    }

    wifiStatus.textContent = "Poslato. ESP treba da pošalje ACK u Serial log i da se prebaci na novu mrežu.";
  } catch (e) {
    wifiStatus.textContent = "Greška: " + e.message;
  }
});

  </script>
</body>
</html>
`;

// HTTP server: isporučuje HTML + admin API za wifi_set
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  // ===== ADMIN API: POST /api/wifi_set?deviceId=...&token=...
  // Body JSON:
  // { "ssid":"...", "pass":"...", "apply": true }
  //
  // Token ovde koristiš isti koji već imaš u ALLOWED_TOKENS.
  // (Možemo kasnije odvojiti ADMIN_TOKEN, ali ovo je najbrže i radi odmah.)
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
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad_json" }));
        return;
      }

      const ssid = String(payload.ssid || "").trim();
      const pass = String(payload.pass || "").trim();
      const apply = payload.apply !== false; // default true

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

      // Ovo je poruka koju ESP32 očekuje (tvoj novi ESP kod)
      const msg = { type: "wifi_set", ssid, pass, apply: !!apply };

      try {
        producer.send(JSON.stringify(msg)); // šaljemo tekstualni WS ka ESP32
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "send_failed" }));
      }
    });

    return;
  }

  // default: HTML UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlPage);
});


const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ noServer: true });

// Mape: deviceId -> set listeners
const listenersByDevice = new Map();
// deviceId -> ws (producer)
const producerByDevice = new Map();

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

server.on("upgrade", (req, socket, head) => {
  // Parse URL da vidimo da li je /ws/device ili /ws/listen
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

wss.on("connection", (ws, req) => {
  const role = ws._role;
  const deviceId = ws._deviceId;

  console.log(`WS connect: role=${role}, deviceId=${deviceId}`);

  if (role === "device") {
    // jedan producer po deviceId
    closeOldProducer(deviceId, ws);

    ws.send("ACK");   //dodata potvrda konekcije

ws.on("message", (data, isBinary) => {
  // 1) Tekstualne poruke od ESP (ACK, status, itd.)
  if (!isBinary) {
    const text = data.toString();
    // očekujemo npr: {"type":"wifi_set_ack","ok":true,"ssid":"..."}
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

  // 2) Binarni audio (kao do sada)
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
    // listener
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

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // "ws" library: ping to keep NAT/proxy alive
    try { ws.ping(); } catch {}
  });
}, 15000);

server.listen(PORT, () => {
  console.log(`✅ Relay v1.0 server na portu ${PORT}`);
});
