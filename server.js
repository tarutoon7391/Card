// ===========================================================================
// server.js — 静的配信 ＋ オンライン対戦サーバー（ゼロ依存）
//
//   ローカル: node server.js → http://localhost:3000
//   Railway:  start コマンドにこのファイルを指定（PORT は環境変数で渡る）
//
// WebSocket は外部ライブラリを使わず Node 標準ライブラリ（http / crypto）だけで実装。
// engine.js を「サーバー権威」で動かし、各クライアントへは serializeFor で
// 席ごとに伏せた state を配信する（相手の手札・山札の中身は見えない）。
//
//   ・ルームコード方式 : 片方が部屋を作成 → コードを共有 → もう片方が入室
//   ・クイックマッチ    : 待機列に並んで先に待っていた相手と自動マッチ
// ===========================================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { createGame, applyAction, serializeFor } from './public/js/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// 静的ファイルサーバー（既存）
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // ディレクトリトラバーサル対策
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===========================================================================
// WebSocket（RFC 6455）— 標準ライブラリだけで実装
// ===========================================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// HTTP → WebSocket アップグレード
server.on('upgrade', (req, socket) => {
  if ((req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  onConnection(socket);
});

const allConns = new Set();
let nextConnId = 1;

// このゲームのメッセージは数百バイト。異常に大きいフレーム長は不正クライアントと見なし切断。
const MAX_BUFFER = 1 << 20; // 1MB

function onConnection(socket) {
  const conn = { id: nextConnId++, socket, room: null, seat: -1, _frag: null };
  allConns.add(conn);
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    // 1接続のフレーム異常で全体（イベントループ）を止めないよう防御的に囲う。
    try {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BUFFER) { handleClose(conn); return; } // 肥大 → 切断
      let frame;
      while ((frame = decodeFrame(buf))) {
        buf = frame.rest;
        handleFrame(conn, frame);
      }
    } catch {
      handleClose(conn);
    }
  });
  socket.on('close', () => handleClose(conn));
  socket.on('error', () => handleClose(conn));
}

// 受信バッファから 1 フレームを取り出す。未完成なら null。
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 4294967296 + lo; offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;

  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, rest: buf.slice(offset + len) };
}

function handleFrame(conn, frame) {
  const { fin, opcode, payload } = frame;

  if (opcode === 0x8) { sendClose(conn); handleClose(conn); return; } // close
  if (opcode === 0x9) { sendFrame(conn.socket, 0xA, payload); return; } // ping → pong
  if (opcode === 0xA) return; // pong は無視

  // text(1) / binary(2) / continuation(0) を組み立てる
  if (opcode === 0x1 || opcode === 0x2) {
    conn._frag = { chunks: [payload] };
  } else if (opcode === 0x0 && conn._frag) {
    conn._frag.chunks.push(payload);
  }
  if (fin && conn._frag) {
    const data = Buffer.concat(conn._frag.chunks);
    conn._frag = null;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    onMessage(conn, msg);
  }
}

function sendFrame(socket, opcode, payload) {
  if (!socket.writable) return;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch { /* 切断済み */ }
}

function sendClose(conn) { sendFrame(conn.socket, 0x8, Buffer.alloc(0)); }

function send(conn, obj) {
  sendFrame(conn.socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

// 30 秒ごとに ping（プロキシのアイドル切断対策）。ブラウザは自動で pong を返す。
setInterval(() => {
  for (const c of allConns) sendFrame(c.socket, 0x9, Buffer.alloc(0));
}, 30000);

// ===========================================================================
// ルーム / マッチメイク
// ===========================================================================
const rooms = new Map();   // code -> room
let quickWaiting = null;    // クイックマッチの待機者（1人）

function genCode() {
  // 紛らわしい文字（0/O/1/I 等）を除いた 4 文字
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function onMessage(conn, msg) {
  switch (msg && msg.t) {
    case 'create':  return createRoom(conn);
    case 'join':    return joinRoom(conn, msg.code);
    case 'quick':   return quickMatch(conn);
    case 'cancel':  return cancelWait(conn);
    case 'action':  return handleAction(conn, msg.action);
    case 'rematch': return handleRematch(conn);
    case 'leave':   return leaveRoom(conn);
    default: /* 未知のメッセージは無視 */
  }
}

function createRoom(conn) {
  leaveRoom(conn);
  const code = genCode();
  const room = { code, conns: [conn], game: null, isQuick: false, rematch: [false, false] };
  conn.room = room; conn.seat = 0;
  rooms.set(code, room);
  send(conn, { t: 'created', code });
}

function joinRoom(conn, rawCode) {
  const code = String(rawCode || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room || room.isQuick) { send(conn, { t: 'error', msg: 'その部屋は見つかりません' }); return; }
  if (room.conns.length >= 2) { send(conn, { t: 'error', msg: 'その部屋は満員です' }); return; }
  leaveRoom(conn);
  conn.room = room; conn.seat = 1;
  room.conns.push(conn);
  startGame(room);
}

function quickMatch(conn) {
  leaveRoom(conn);
  if (quickWaiting && quickWaiting !== conn && quickWaiting.socket.writable) {
    const other = quickWaiting; quickWaiting = null;
    const code = genCode();
    const room = { code, conns: [other, conn], game: null, isQuick: true, rematch: [false, false] };
    other.room = room; other.seat = 0;
    conn.room = room; conn.seat = 1;
    rooms.set(code, room);
    startGame(room);
  } else {
    quickWaiting = conn;
    send(conn, { t: 'waiting' });
  }
}

function cancelWait(conn) {
  if (quickWaiting === conn) quickWaiting = null;
  leaveRoom(conn);
}

function startGame(room) {
  // 先攻はランダム（createGame 内で決まる）。シードはサーバーだけが保持。
  room.game = createGame();
  room.rematch = [false, false];
  for (const c of room.conns) {
    send(c, { t: 'start', seat: c.seat, state: serializeFor(room.game, c.seat) });
  }
}

function handleAction(conn, action) {
  const room = conn.room;
  if (!room || !room.game) return;
  const game = room.game;
  if (game.phase !== 'playing') return;
  if (game.active !== conn.seat) return; // 手番でない人の操作は破棄（サーバー権威）
  const res = applyAction(game, action);
  if (!res.ok) { send(conn, { t: 'reject', reason: res.reason }); return; }
  broadcastState(room, res.events);
}

function broadcastState(room, events) {
  for (const c of room.conns) {
    send(c, { t: 'state', state: serializeFor(room.game, c.seat), events: events || [] });
  }
}

function handleRematch(conn) {
  const room = conn.room;
  if (!room || !room.game || room.game.phase !== 'gameover') return;
  room.rematch[conn.seat] = true;
  const other = room.conns.find((c) => c !== conn);
  if (other) send(other, { t: 'rematchOffered' });
  if (room.conns.length === 2 && room.rematch[0] && room.rematch[1]) startGame(room);
}

// 部屋から抜ける（明示退室・切断の両方で使う）。部屋ごと解散し、残った相手に通知。
function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  rooms.delete(room.code);
  for (const c of room.conns) {
    if (c !== conn && c.socket.writable) send(c, { t: 'opponentLeft' });
    c.room = null; c.seat = -1;
  }
}

function handleClose(conn) {
  if (!allConns.has(conn)) return; // 二重 close ガード
  allConns.delete(conn);
  if (quickWaiting === conn) quickWaiting = null;
  leaveRoom(conn);
  try { conn.socket.destroy(); } catch { /* noop */ }
}

server.listen(PORT, () => {
  console.log(`ライン職 → http://localhost:${PORT}（オンライン対戦対応）`);
});
