// websocket_server.js — Relay v1.0 (ESP32 device -> listeners) + HTML player
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

// ====== KONFIG (kasnije prebaci u ENV) ======
const ALLOWED_TOKENS = new Set([
  "XYZ_SECRET_TOKEN",   // primer: token za dev001
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
  <title>ESP32 Audio Stream (v1.0)</title>
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
  <input id="devId" value="dev001" />

  <p>Token:</p>
  <input id="token" value="XYZ_SECRET_TOKEN" />

  <div style="margin-top: 15px;">
    <button id="startBtn">Start audio</button>
  </div>

  <div id="status">Čekam konekciju...</div>

  <script>
    const statusDiv = document.getElementById('status');
    const startBtn  = document.getElementById('startBtn');
    const devIdInp  = document.getElementById('devId');
    const tokenInp  = document.getElementById('token');

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
      initAudio();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      connectWS();
      startBtn.disabled = true;
      startBtn.textContent = 'Audio radi';
      statusDiv.textContent = 'Povezujem...';
    });
  </script>
</body>
</html>
`;

// HTTP server: isporučuje HTML
const server = http.createServer((req, res) => {
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

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;

      // Ugovor v1.0: 320 bajta po frame-u (20ms PCM16)
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

server.listen(PORT, () => {
  console.log(`✅ Relay v1.0 server na portu ${PORT}`);
});
