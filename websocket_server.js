const http = require('http');
const WebSocket = require('ws');

// Kreiramo osnovni HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ESP32 WebSocket Server radi ✅');
});

// Kreiramo WebSocket server koji \"sedi\" na istom portu
const wss = new WebSocket.Server({ server });

// Kada se klijent poveže (ESP32 ili browser)
wss.on('connection', (ws) => {
  console.log('📡 Novi klijent povezan');

  ws.on('message', (message) => {
    console.log('📥 Poruka primljena:', message.toString());
    ws.send('✅ Server je primio tvoju poruku');
  });

  ws.on('close', () => {
    console.log('❌ Klijent se odjavio');
  });
});

// Render dodeljuje port automatski
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 WebSocket server pokrenut na portu ${PORT}`);
});
