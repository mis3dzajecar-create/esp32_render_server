const http = require('http');
const WebSocket = require('ws');

// --- HTML koji se prikazuje u browseru ---
const htmlPage = `
<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>ESP32 Taster</title>
<style>
  body { font-family: Arial; text-align:center; margin-top:60px; }
  #status { font-size:48px; font-weight:bold; }
  .on  { color:green; }
  .off { color:red; }
</style>
</head>
<body>
  <h1>ESP32 WebSocket prikaz tastera</h1>
  <div id="status" class="off">OFF</div>
  <script>
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
    ws.onmessage = (event) => {
      const msg = event.data.trim();
      const status = document.getElementById('status');
      if (msg === "ON") { status.textContent = "ON"; status.className = "on"; }
      else if (msg === "OFF") { status.textContent = "OFF"; status.className = "off"; }
    };
  </script>
</body>
</html>
`;

// --- HTTP server ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage);
});

// --- WebSocket server ---
const wss = new WebSocket.Server({ server });
let esp32Socket = null;

wss.on('connection', (ws, req) => {
  console.log('📡 Novi klijent povezan');

  ws.on('message', (message) => {
    console.log('📥 Poruka primljena:', message.toString());
    // Ako je ovo ESP32 (šalje ON/OFF), zapamti ga
    if (message.toString() === 'ON' || message.toString() === 'OFF') {
      esp32Socket = ws;
      // Prosledi svim klijentima (browserima)
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(message.toString());
        }
      });
    }
  });

  ws.on('close', () => console.log('❌ Klijent se odjavio'));
});

// --- Port od Render-a ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () =>
  console.log(`🌐 WebSocket server pokrenut na portu ${PORT}`)
);
