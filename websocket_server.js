// websocket_server.js (Node.js)
const WebSocket = require('ws');

// Koristi Render-ov port iz okruženja, ili 3000 lokalno za razvoj
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`✅ WebSocket server pokrenut na portu ${PORT}`);
});

// Event handler za novu konekciju
wss.on('connection', (ws, req) => {
  console.log('👋 Novi WebSocket klijent povezan:', req.socket.remoteAddress);
  
  // Po želji: podešavanje periodičnog pingovanja ili slično radi održavanja veze
  ws.on('pong', () => {/* heartbeat potvrda, ako implementirate ping-pong */});
  
  // Prijem poruke od klijenta
  ws.on('message', (message) => {
    console.log('📨 Primljena poruka:', message.toString());
    // Primer: odgovor istu poruku nazad klijentu (echo)
    ws.send(`🤖 Server echo: ${message}`);
  });
  
  // Obrada zatvaranja konekcije
  ws.on('close', () => {
    console.log('🔌 Klijent je zatvorio vezu.');
  });
  
  // Obrada grešaka na konekciji
  ws.on('error', (err) => {
    console.error('⚠️ Greška na WS konekciji:', err);
  });
});