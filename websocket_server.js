// websocket_server.js
const http = require('http');
const WebSocket = require('ws');

// HTML koji prikazuje stanje tastera
const htmlPage = `
<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="UTF-8">
  <title>ESP32 Taster</title>
  <style>
    body { font-family: sans-serif; text-align: center; margin-top: 50px; }
    h1 { font-size: 28px; }
    #status { font-size: 48px; font-weight: bold; margin-top: 20px; }
    .on  { color: green; }
    .off { color: red; }
  </style>
</head>
<body>
  <h1>Stanje tastera na ESP32</h1>
  <div id="status" class="off">OFF</div>
  <script>
    const ws = new WebSocket("wss://esp32-websocket-server-8agw.onrender.com");
    ws.onmessage = (event) => {
      const msg = event.data.trim();
      const statusDiv = document.getElementById("status");
      if (msg === "ON") {
        statusDiv.textContent = "ON";
        statusDiv.className = "on";
      } else if (msg === "OFF") {
        statusDiv.textContent = "OFF";
        statusDiv.className = "off";
      }
    };
  </script>
</body>
</html>
`;

// HTTP server koji isporučuje HTML
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage);
});

// WebSocket server
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('📡 Novi klijent povezan:', req.socket.remoteAddress);

  ws.on('message', (message) => {
    console.log('📥 Poruka primljena:', message.toString());
    // Prosleđujemo svim ostalim klijentima (npr. browser)
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('🔌 Klijent se odjavio');
  });

  ws.on('error', (err) => {
    console.error('⚠️ Greška na WS konekciji:', err);
  });
});

// Pokretanje servera
server.listen(PORT, () => {
  console.log(`✅ WebSocket server pokrenut na portu ${PORT}`);
});
