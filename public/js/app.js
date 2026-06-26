// ===========================================================================
// app.js — ロビーと接続のオーケストレーション。
//   ・ロビー画面のボタン配線（CPU対戦 / 部屋を作る / コード参加 / クイックマッチ）
//   ・サーバーとの WebSocket 接続を 1 本保持し、サーバー通知をゲーム UI へ橋渡し
//   ・招待 URL（?room=CODE）による自動参加
// ゲーム盤面そのものの描画・入力は ui.js が担当する。
// ===========================================================================

import { connect } from './net.js';
import * as ui from './ui.js';

let net = null;
let pending = [];     // 接続が開くまでの送信キュー

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 接続管理（必要になったら遅延接続。開くまで送信をキュー）
// ---------------------------------------------------------------------------
function ensureNet() {
  if (net) return;
  net = connect({
    onOpen: () => { const q = pending; pending = []; for (const m of q) net.send(m); },
    onClose: () => onNetClose(),
    onMessage: onServerMessage,
  });
}

function send(msg) {
  ensureNet();
  if (net.isOpen()) net.send(msg);
  else pending.push(msg);
}

function onNetClose() {
  net = null;
  pending = [];
  // ゲーム/待機中に切れたらロビーへ戻す
  if (!$('app').classList.contains('hidden') || !$('waiting').classList.contains('hidden')) {
    showLobby('サーバーとの接続が切れました。もう一度お試しください。');
  }
}

// ---------------------------------------------------------------------------
// サーバー通知 → 画面遷移 / ゲーム UI
// ---------------------------------------------------------------------------
function onServerMessage(msg) {
  switch (msg.t) {
    case 'created':        showWaitingRoom(msg.code); break;
    case 'waiting':        showWaitingQuick(); break;
    case 'start':          ui.startOnlineGame(net, msg.seat, msg.state); break;
    case 'state':          ui.onlineState(msg.state, msg.events); break;
    case 'opponentLeft':   ui.onlineOpponentLeft(); break;
    case 'rematchOffered': ui.onlineRematchOffered(); break;
    case 'error':          showLobby(msg.msg); break;
    case 'reject':         /* サーバーが弾いた不正手。UI は次の state で同期されるので無視 */ break;
    default: /* noop */
  }
}

// ---------------------------------------------------------------------------
// 画面切り替え
// ---------------------------------------------------------------------------
function showScreen(id) {
  for (const s of ['lobby', 'waiting', 'app']) $(s).classList.toggle('hidden', s !== id);
  $('overlay').classList.add('hidden');
}

function showLobby(errMsg) {
  showScreen('lobby');
  $('lobby-error').textContent = errMsg || '';
}

function showWaitingRoom(code) {
  showScreen('waiting');
  $('waiting-msg').textContent = '相手の参加を待っています…';
  $('waiting-code').innerHTML = `合言葉： <b>${code}</b>`;
  const link = `${location.origin}/?room=${code}`;
  $('waiting-share').innerHTML =
    `<div class="share-row"><input id="share-link" readonly value="${link}" />` +
    `<button id="copy-link" class="btn">コピー</button></div>` +
    `<div class="hint">このコード（または上のURL）を相手に送ってください</div>`;
  $('copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('copy-link').textContent = 'コピーしました';
    } catch {
      const inp = $('share-link'); inp.focus(); inp.select();
    }
  };
}

function showWaitingQuick() {
  showScreen('waiting');
  $('waiting-msg').textContent = '対戦相手を探しています…';
  $('waiting-code').textContent = '';
  $('waiting-share').innerHTML = '<div class="hint">誰かが参加すると自動で対戦が始まります</div>';
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
export function start() {
  // ui.js からの「ロビーへ戻る / 再戦」要求を受ける
  ui.setHooks({
    leaveToLobby: () => { send({ t: 'leave' }); showLobby(); },
    rematch: () => { send({ t: 'rematch' }); },
  });

  // ロビーのボタン配線
  $('btn-cpu').onclick = () => ui.startCpuGame();
  $('btn-create').onclick = () => send({ t: 'create' });
  $('btn-quick').onclick = () => send({ t: 'quick' });
  $('btn-join').onclick = () => doJoin($('join-code').value);
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin($('join-code').value); });
  $('waiting-cancel').onclick = () => { send({ t: 'cancel' }); showLobby(); };

  // 招待 URL（?room=CODE）なら自動で参加
  const code = new URLSearchParams(location.search).get('room');
  if (code) {
    showScreen('lobby');
    $('lobby-error').textContent = '接続中…';
    doJoin(code);
  } else {
    showLobby();
  }
}

function doJoin(raw) {
  const code = String(raw || '').toUpperCase().trim();
  if (code.length < 4) { showLobby('コードは4文字です'); return; }
  send({ t: 'join', code });
}
