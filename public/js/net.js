// ===========================================================================
// net.js — サーバーとの WebSocket 接続をラップするだけの薄い層。
//   connect(handlers) で接続し、send(obj) で JSON を送る。
//   受信した JSON は handlers.onMessage(msg) に渡す。
// ===========================================================================

export function connect(handlers = {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => handlers.onOpen && handlers.onOpen());
  ws.addEventListener('close', () => handlers.onClose && handlers.onClose());
  ws.addEventListener('error', () => handlers.onError && handlers.onError());
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handlers.onMessage && handlers.onMessage(msg);
  });

  return {
    raw: ws,
    send: (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
}
