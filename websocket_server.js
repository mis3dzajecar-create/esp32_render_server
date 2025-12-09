// websocket_server.js — audio streaming sa ESP32 na browser
const http = require('http');
const WebSocket = require('ws');

// Jednostavna HTML stranica sa live audio playerom
const htmlPage = `
<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8" />
  <title>ESP32 Audio Stream</title>
  <style>
    body { font-family: sans-serif; text-align: center; margin-top: 40px; }
    h1 { font-size: 26px; }
    #status { margin-top: 10px; font-size: 14px; color: #555; }
    button { padding: 10px 20px; font-size: 16px; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>ESP32 Audio Live Stream</h1>
  <p>Klikni na dugme da pokreneš audio (zbog browser policy-ja).</p>
  <button id="startBtn">Start audio</button>
  <div id="status">Čekam konekciju...</div>

  <script>
    const statusDiv = document.getElementById('status');
    const startBtn  = document.getElementById('startBtn');

    // WebSocket ka ISTOM hostu odakle je došao HTML (Render domen)
    const ws = new WebSocket(
      (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
    );
    ws.binaryType = 'arraybuffer';

    let audioCtx = null;
    let scriptNode = null;
    let audioBuffer = [];   // niz Int16Array chunkova
    let bufferOffset = 0;

    function queueAudio(int16Samples) {
      audioBuffer.push(int16Samples);
    }

    function initAudio() {
      if (audioCtx) return;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000   // isti kao na ESP32
      });

      scriptNode = audioCtx.createScriptProcessor(1024, 0, 1);
      scriptNode.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) {
          if (audioBuffer.length === 0) {
            out[i] = 0; // tišina
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

          // Int16 -> float [-1,1]
          out[i] = current[bufferOffset++] / 32768;
        }
      };

      scriptNode.connect(audioCtx.destination);
      audioCtx.resume();
      statusDiv.textContent = 'Audio pokrenut, čekam podatke...';
    }

    ws.onopen = () => {
      statusDiv.textContent = 'WebSocket povezan (čekam audio)...';
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const msg = event.data.trim();
        console.log('TEXT:', msg);
        // tekst se može koristiti za debug, ali nije obavezan
        return;
      }

      // binarni audio frame (PCM16 mono)
      const arrayBuffer = event.data; // već je ArrayBuffer zbog binaryType
      const samples = new Int16Array(arrayBuffer);
      queueAudio(samples);
    };

    ws.onclose = () => {
      statusDiv.textContent = 'Veza zatvorena';
    };

    ws.onerror = (err) => {
      console.error('WS error:', err);
      statusDiv.textContent = 'Greška na WebSocket vezi';
    };

    startBtn.addEventListener('click', async () => {
      initAudio();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      startBtn.disabled = true;
      startBtn.textContent = 'Audio radi';
    });
  </script>
</body>
</html>
`;

// HTTP server koji isporučuje HTML
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage);
});

// WebSocket server (Render prosleđuje port kroz env varijablu)
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('📡 Novi klijent povezan:', req.socket.remoteAddress);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // audio frejm od ESP32 – prosledi svim browser klijentima
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: true });
        }
      });
    } else {
      const text = data.toString();
      console.log('📥 Tekst poruka:', text);
      // tekst možemo i dalje broadcast-ovati ako želimo
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(text);
        }
      });
    }
  });

  ws.on('close', () => {
    console.log('🔌 Klijent se odjavio');
  });

  ws.on('error', (err) => {
    console.error('⚠️ Greška na WS konekciji:', err);
  });
});

server.listen(PORT, () => {
  console.log(`✅ WebSocket server pokrenut na portu ${PORT}`);
});
