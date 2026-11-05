'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, 'index.html');
const W = 15, H = 10, CELL = 60;
const SOLID = new Set(['wall', 'sofa', 'plant', 'table', 'shelf', 'crate']);
const rooms = new Map();
const OPEN = 1;

function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) found.push(item.address);
    }
  }
  return [...new Set(found)];
}

// Pequeno servidor WebSocket sem dependências externas. Aceita mensagens de texto
// enviadas pelos navegadores e responde com frames WebSocket padrão.
class WebSocketPeer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.maxPayload = 256 * 1024;
    this.closed = false;
    socket.on('data', chunk => this.consume(chunk));
    socket.on('close', () => this.finishClose());
    socket.on('error', err => { this.emit('error', err); this.finishClose(); });
  }
  send(value) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.from(String(value));
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
  close() {
    if (this.readyState !== OPEN) return;
    this.readyState = 2;
    try { this.socket.write(Buffer.from([0x88, 0x00])); } catch {}
    this.socket.end();
    this.finishClose();
  }
  finishClose() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3; this.emit('close');
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) { this.close(); return; }
        length = Number(big); offset = 10;
      }
      if (length > this.maxPayload) { this.close(); return; }
      if (!masked) { this.close(); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.emit('message', payload);
      else if (opcode === 0x8) { this.close(); return; }
      else if (opcode === 0x9) this.writeControl(0xA, payload);
      else if (opcode === 0xA) { /* pong: keep connection alive */ }
    }
  }
  writeControl(opcode, payload) {
    if (this.readyState !== OPEN) return;
    const data = Buffer.from(payload || []);
    if (data.length > 125) return;
    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]));
  }
}

function send(ws, data) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(data));
}
function cleanName(value) {
  const name = String(value || 'Jogador').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || 'Jogador';
}
function validColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
function sanitizeMap(raw) {
  if (!raw || !Array.isArray(raw.cells) || raw.cells.length !== W * H) return null;
  const cells = [];
  for (const cell of raw.cells) {
    if (!cell || !validColor(cell.floor) || (cell.obj != null && !['wall','sofa','plant','table','shelf','crate','rug','lamp'].includes(cell.obj))) return null;
    cells.push({ floor: cell.floor, obj: cell.obj || null });
  }
  for (let x = 0; x < W; x++) { cells[x].obj = 'wall'; cells[(H - 1) * W + x].obj = 'wall'; }
  for (let y = 0; y < H; y++) { cells[y * W].obj = 'wall'; cells[y * W + W - 1].obj = 'wall'; }
  return { name: String(raw.name || 'Mapa').slice(0, 28), desc: String(raw.desc || 'Mapa personalizado.').slice(0, 120), width: W, height: H, cells, accent: validColor(raw.accent) ? raw.accent : '#b7f36b' };
}
function isSolid(map, x, y) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return true;
  return SOLID.has(map.cells[cy * W + cx].obj);
}
function canMove(map, x, y, radius = 12) {
  return !isSolid(map, x-radius, y-radius) && !isSolid(map, x+radius, y-radius) && !isSolid(map, x-radius, y+radius) && !isSolid(map, x+radius, y+radius);
}
function spawnFor(map, used) {
  const candidates = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) candidates.push({ x: (x + .5) * CELL, y: (y + .5) * CELL });
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  return candidates.find(pos => !isSolid(map, pos.x, pos.y) && used.every(p => Math.hypot(p.x-pos.x, p.y-pos.y) > 38)) || { x: 450, y: 300 };
}
function publicPlayer(p) { return { id:p.id, name:p.name, x:p.x, y:p.y, role:p.role, found:p.found, pose:p.pose, paint:p.paint, paintRev:p.paintRev }; }
function stateFor(room) {
  const now = Date.now();
  const timeLeft = room.phase === 'hide' ? Math.max(0, Math.ceil((room.hideEndsAt-now)/1000)) : room.phase === 'hunt' ? Math.max(0, Math.ceil((room.huntEndsAt-now)/1000)) : 0;
  return { type:'state', code:room.code, hostId:room.hostId, phase:room.phase, winner:room.winner, timeLeft, map:room.map, players:[...room.players.values()].map(publicPlayer) };
}
function broadcast(room) {
  const payload = JSON.stringify(stateFor(room));
  for (const p of room.players.values()) if (p.ws.readyState === OPEN) p.ws.send(payload);
}
function broadcastError(ws, message) { send(ws, { type:'error', message }); }
function removePlayer(ws) {
  const id=ws.playerId, code=ws.roomCode;
  if (!id || !code) return;
  const room=rooms.get(code); if (!room) return;
  room.players.delete(id); ws.playerId=null; ws.roomCode=null;
  if (room.players.size===0) { rooms.delete(code); return; }
  if (room.hostId===id) room.hostId=room.players.keys().next().value;
  if (room.phase==='hunt' && [...room.players.values()].filter(p=>p.role==='hider'&&!p.found).length===0) { room.phase='over'; room.winner='seeker'; }
  broadcast(room);
}
function makePlayer(ws, id, name) {
  const p={ id, name:cleanName(name), ws, x:450, y:300, role:'hider', found:false, pose:false, paint:[], paintRev:0, input:{dx:0,dy:0} };
  ws.playerId=id; return p;
}
function makeRoomCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do { code=Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); } while(rooms.has(code));
  return code;
}
function startRound(room) {
  const players=[...room.players.values()], seekerIndex=Math.floor(Math.random()*players.length), placed=[];
  players.forEach((p,i)=>{const pos=spawnFor(room.map,placed);p.x=pos.x;p.y=pos.y;p.role=i===seekerIndex?'seeker':'hider';p.found=false;p.pose=false;p.paint=[];p.paintRev++;p.input={dx:0,dy:0};placed.push(pos)});
  room.phase='hide';room.winner=null;room.hideEndsAt=Date.now()+30000;room.huntEndsAt=0;
}
function handleConnection(ws) {
  const stableId=crypto.randomBytes(5).toString('hex').toUpperCase();
  send(ws,{type:'hello',id:stableId,addresses:lanAddresses()});
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw.toString())}catch{broadcastError(ws,'Mensagem inválida.');return}
    if(!msg||typeof msg.type!=='string')return;
    if(msg.type==='createRoom'){
      if(ws.roomCode)removePlayer(ws);
      const map=sanitizeMap(msg.map);if(!map){broadcastError(ws,'O mapa enviado é inválido.');return}
      const code=makeRoomCode(),p=makePlayer(ws,stableId,msg.name);
      const room={code,hostId:p.id,players:new Map([[p.id,p]]),map,phase:'lobby',winner:null,hideEndsAt:0,huntEndsAt:0};
      ws.roomCode=code;rooms.set(code,room);send(ws,{type:'roomJoined',code});broadcast(room);return;
    }
    if(msg.type==='joinRoom'){
      if(ws.roomCode)removePlayer(ws);
      const code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),room=rooms.get(code);
      if(!room){broadcastError(ws,'Sala não encontrada. Confira o código.');return}
      if(room.phase!=='lobby'){broadcastError(ws,'Essa partida já começou. Peça ao anfitrião para criar outra sala.');return}
      if(room.players.size>=10){broadcastError(ws,'A sala está cheia (máximo de 10 jogadores).');return}
      const p=makePlayer(ws,stableId,msg.name);ws.roomCode=code;room.players.set(p.id,p);send(ws,{type:'roomJoined',code});broadcast(room);return;
    }
    const room=ws.roomCode?rooms.get(ws.roomCode):null,player=room&&room.players.get(ws.playerId);
    if(!room||!player){if(msg.type!=='leave')broadcastError(ws,'Entre em uma sala primeiro.');return}
    if(msg.type==='leave'){removePlayer(ws);return}
    if(msg.type==='startGame'){
      if(player.id!==room.hostId){broadcastError(ws,'Somente o anfitrião pode iniciar a partida.');return}
      if(room.players.size<2){broadcastError(ws,'São necessários pelo menos 2 jogadores.');return}
      if(room.phase==='lobby'||room.phase==='over')startRound(room);broadcast(room);return;
    }
    if(msg.type==='input'){
      const dx=Math.max(-1,Math.min(1,Number(msg.dx)||0)),dy=Math.max(-1,Math.min(1,Number(msg.dy)||0)),len=Math.hypot(dx,dy)||1;
      player.input={dx:dx/len,dy:dy/len};return;
    }
    if(msg.type==='pose'){if(room.phase==='hide'&&player.role==='hider')player.pose=!!msg.value;return}
    if(msg.type==='paintStroke'){
      if(room.phase!=='hide'||player.role!=='hider')return;
      const s=msg.stroke;if(!s||!Array.isArray(s.points)||s.points.length<1||s.points.length>260)return;
      if(!s.erase&&!validColor(s.color))return;
      const points=s.points.map(pt=>({x:Math.max(0,Math.min(100,Number(pt.x)||0)),y:Math.max(0,Math.min(140,Number(pt.y)||0))}));
      player.paint.push({color:validColor(s.color)?s.color:'#ffffff',width:Math.max(1,Math.min(22,Number(s.width)||7)),erase:!!s.erase,points});
      if(player.paint.length>320)player.paint.splice(0,player.paint.length-320);player.paintRev++;return;
    }
    if(msg.type==='clearPaint'){if(room.phase==='hide'&&player.role==='hider'){player.paint=[];player.paintRev++}return}
    if(msg.type==='tag'){
      if(room.phase!=='hunt'||player.role!=='seeker')return;
      const target=room.players.get(String(msg.targetId||''));if(!target||target.role!=='hider'||target.found)return;
      if(Math.hypot(player.x-target.x,player.y-target.y)<=78){target.found=true;target.pose=false;target.input={dx:0,dy:0};const remaining=[...room.players.values()].filter(p=>p.role==='hider'&&!p.found).length;if(remaining===0){room.phase='over';room.winner='seeker'}broadcast(room)}return;
    }
  });
  ws.on('close',()=>removePlayer(ws));
  ws.on('error',()=>removePlayer(ws));
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/api/info'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({port:PORT,addresses:lanAddresses()}));return}
  if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('MECCHA 2D server online');return}
  if(url.pathname==='/'||url.pathname==='/index.html'){fs.readFile(HTML_FILE,(err,data)=>{if(err){res.writeHead(500);res.end('index.html não encontrado. Extraia todos os arquivos do projeto.');return}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(data)});return}
  res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');
});
server.on('upgrade',(req,socket)=>{
  const key=req.headers['sec-websocket-key'];
  if(req.headers.upgrade?.toLowerCase()!=='websocket'||!key){socket.destroy();return}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.setNoDelay(true);
  handleConnection(new WebSocketPeer(socket));
});

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    if(room.phase==='hide'&&now>=room.hideEndsAt){room.phase='hunt';room.huntEndsAt=now+120000;for(const p of room.players.values())p.input={dx:0,dy:0}}
    else if(room.phase==='hunt'&&now>=room.huntEndsAt){room.phase='over';room.winner='hiders'}
    if(room.phase==='hide'||room.phase==='hunt'){
      for(const p of room.players.values()){
        if(p.found||p.pose)continue;
        const active=(room.phase==='hide'&&p.role==='hider')||(room.phase==='hunt'&&p.role==='seeker');if(!active)continue;
        const speed=p.role==='seeker'?185:155,dt=.05,nx=p.x+p.input.dx*speed*dt,ny=p.y+p.input.dy*speed*dt;
        if(canMove(room.map,nx,p.y))p.x=nx;if(canMove(room.map,p.x,ny))p.y=ny;
      }
    }
    broadcast(room);
  }
},50);

server.listen(PORT,'0.0.0.0',()=>{
  console.log('\n=== MECCHA 2D — SERVIDOR MULTIPLAYER ===');
  console.log(`Este computador: http://localhost:${PORT}`);
  for(const ip of lanAddresses())console.log(`Rede Wi-Fi/LAN: http://${ip}:${PORT}`);
  console.log('Mantenha esta janela aberta enquanto estiver jogando.\n');
});
