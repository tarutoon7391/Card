// ===========================================================================
// ui.js — 描画と入力処理。engine の純粋関数を呼ぶだけで、ゲームの真実は engine が持つ。
//
// 2 つのモードで同じ盤面 UI を使う：
//   ・cpu    : ローカルで applyAction を直接適用し、CPU ターンを ai.js で回す（オフライン）
//   ・online : 操作は action としてサーバーへ送り、返ってきた state を描くだけ（サーバー権威）
//
// engine は DOM 非依存の純粋モジュールなので、UI は「state を読んで描く」「入力を action に
// 変換する」ことに徹し、適用先（ローカル engine / サーバー）だけをモードで切り替える。
// ===========================================================================

import { CARD_DB } from './cards.js';
import {
  createGame, applyAction, effectiveAtk, completedLines, lineBonus,
  hasValidAttack, canAct, BOARD_SIZE, LEADER_HP, MAX_MANA,
} from './engine.js';
import { aiNextAction } from './ai.js';

// 盤面に表示する短縮名
const SHORT = {
  seihei: '整列兵', totsugeki: '突撃兵', denrei: '伝令', lineload: 'ロード',
};
const KW_ICON = { speed: '⚡', leader: '⚑' };

const G = {
  game: null,
  mode: 'cpu',   // 'cpu' | 'online'
  mySeat: 0,     // 自分の席（online はサーバーが割り当て）
  foeSeat: 1,    // 相手の席
  foeLabel: 'CPU',
  net: null,     // online 時のサーバー接続（net.js の戻り値）
  sel: null,     // 入力モード: {mode:'place'|'repoFrom'|'repoTo', iid, from?}
  busy: false,   // CPU 行動中・演出中・サーバー応答待ちのロック
  flash: null,   // {side, index, type} 直近アクションの演出
};

let hooks = { leaveToLobby: () => {}, rematch: () => {} };
let bound = false;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function setHooks(h) { hooks = { ...hooks, ...h }; }

// ---------------------------------------------------------------------------
// 画面切り替え（ロビー/待機/ゲーム）
// ---------------------------------------------------------------------------
function showGameScreen() {
  for (const id of ['lobby', 'waiting']) { const el = $(id); if (el) el.classList.add('hidden'); }
  $('app').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 起動（モードごと）
// ---------------------------------------------------------------------------
export function startCpuGame() {
  G.mode = 'cpu';
  G.mySeat = 0; G.foeSeat = 1; G.foeLabel = 'CPU';
  G.net = null;
  resetGame(createGame());
  if (G.game.active === G.foeSeat) runCpuTurn();
}

export function startOnlineGame(net, seat, state) {
  G.mode = 'online';
  G.net = net;
  G.mySeat = seat; G.foeSeat = 1 - seat; G.foeLabel = '相手';
  resetGame(state);
}

function resetGame(game) {
  ensureBound();
  G.game = game;
  G.sel = null;
  G.flash = null;
  G.busy = false;
  document.body.classList.remove('busy');
  showGameScreen();
  $('overlay').classList.add('hidden');
  updateChrome();
  render();
}

// 上部「新しい対戦/ロビーへ」ボタンやオーバーレイのラベルをモードに合わせる
function updateChrome() {
  $('new-game').textContent = G.mode === 'online' ? 'ロビーへ戻る' : '新しい対戦';
}

function ensureBound() {
  if (bound) return;
  bound = true;
  bindEvents();
}

function bindEvents() {
  $('new-game').onclick = () => {
    if (G.mode === 'online') hooks.leaveToLobby();
    else startCpuGame();
  };
  $('overlay-again').onclick = () => {
    if (G.mode === 'online') {
      hooks.rematch();
      $('overlay-msg').textContent = '相手の応答を待っています…';
      $('overlay-again').disabled = true;
    } else {
      startCpuGame();
    }
  };
  const overlayLobby = $('overlay-lobby');
  if (overlayLobby) overlayLobby.onclick = () => hooks.leaveToLobby();

  $('end-turn').onclick = () => {
    if (!isMyTurn()) return;
    G.sel = null;
    doAction({ type: 'END_TURN' });
  };
  // 盤面クリック（イベント委譲）
  $('me-board').addEventListener('click', (e) => onCellClick(e, 'me'));
  $('foe-board').addEventListener('click', (e) => onCellClick(e, 'foe'));
  // 同座標干渉のホバー表示
  for (const id of ['me-board', 'foe-board']) {
    const el = $(id);
    el.addEventListener('mouseover', (e) => onCellHover(e, true));
    el.addEventListener('mouseout', (e) => onCellHover(e, false));
  }
  // 手札クリック
  $('hand').addEventListener('click', onHandClick);
}

function isMyTurn() {
  return G.game && G.game.phase === 'playing' && G.game.active === G.mySeat && !G.busy;
}

// ---------------------------------------------------------------------------
// オンライン：サーバーからの通知ハンドラ（app.js から呼ばれる）
// ---------------------------------------------------------------------------
export function onlineState(state, events) {
  G.game = state;
  G.busy = false;
  G.sel = null; // 状態が進んだら選択はリセット（安全側）
  applyEventFlash(events);
  render();
  if (G.game.phase === 'gameover') showOverlay();
}

export function onlineOpponentLeft() {
  if (G.mode !== 'online') return;
  $('overlay-msg').textContent = '相手が退室しました';
  $('overlay-again').classList.add('hidden');
  const lobbyBtn = $('overlay-lobby');
  if (lobbyBtn) lobbyBtn.classList.remove('hidden');
  $('overlay').classList.remove('hidden');
}

export function onlineRematchOffered() {
  // 相手が「もう一度」を押した。こちらも押せば再戦が始まる（startOnlineGame が来る）。
  if (G.game && G.game.phase === 'gameover') {
    $('overlay-msg').textContent = '相手は再戦を希望しています';
  }
}

// 相手の攻撃などをこちら側でも軽く演出する
function applyEventFlash(events) {
  if (!events) return;
  for (const e of events) {
    if (e.kind === 'attack' || e.kind === 'leaderHit') {
      const side = e.seat === G.mySeat ? 'me' : 'foe';
      G.flash = { side, index: e.index, type: 'atk' };
    }
  }
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------
function onHandClick(e) {
  if (!isMyTurn()) return;
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const iid = Number(cardEl.dataset.iid);
  const me = G.game.players[G.mySeat];
  const inst = me.hand.find((c) => c.instanceId === iid);
  if (!inst) return;
  const card = CARD_DB[inst.cardId];
  if (card.cost > me.mana) return; // 払えない

  // 同じカード再クリックで選択解除
  if (G.sel && G.sel.iid === iid) { G.sel = null; render(); return; }

  if (card.type === 'statue') {
    G.sel = { mode: 'place', iid };
    render();
  } else if (card.spell === 'reposition') {
    // 自分の石像が1体以上、空きマスが1つ以上必要
    const hasStatue = me.board.some((s) => s != null);
    const hasEmpty = me.board.some((s) => s == null);
    if (!hasStatue || !hasEmpty) return;
    G.sel = { mode: 'repoFrom', iid };
    render();
  } else if (card.spell === 'mana') {
    doAction({ type: 'PLAY', instanceId: iid });
  }
}

function onCellClick(e, side) {
  if (!isMyTurn()) return;
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const i = Number(cellEl.dataset.index);
  const me = G.game.players[G.mySeat];

  // 配置モード（自分の盤面の空きマス）
  if (G.sel && G.sel.mode === 'place' && side === 'me') {
    if (me.board[i] == null) {
      doAction({ type: 'PLAY', instanceId: G.sel.iid, index: i });
      G.sel = null;
    }
    return;
  }
  // 再配置：移動元選択
  if (G.sel && G.sel.mode === 'repoFrom' && side === 'me') {
    if (me.board[i] != null) { G.sel = { mode: 'repoTo', iid: G.sel.iid, from: i }; render(); }
    return;
  }
  // 再配置：移動先選択
  if (G.sel && G.sel.mode === 'repoTo' && side === 'me') {
    if (me.board[i] == null) {
      doAction({ type: 'PLAY', instanceId: G.sel.iid, from: G.sel.from, to: i });
      G.sel = null;
    }
    return;
  }
  // 選択なし → 自分の石像で攻撃
  if (!G.sel && side === 'me') {
    if (hasValidAttack(G.game, G.mySeat, i)) {
      G.flash = { side: 'me', index: i, type: 'atk' };
      doAction({ type: 'ATTACK', from: i });
    }
  }
}

function onCellHover(e, on) {
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const i = cellEl.dataset.index;
  for (const id of ['me-board', 'foe-board']) {
    const c = $(id).querySelector(`.cell[data-index="${i}"]`);
    if (c) c.classList.toggle('cross', on);
  }
}

// ---------------------------------------------------------------------------
// アクション適用（モードで適用先を切り替える）
// ---------------------------------------------------------------------------
function doAction(action) {
  if (G.mode === 'online') {
    // サーバー権威：ローカルでは適用せず送信のみ。応答(state)が来たら再描画。
    G.busy = true;            // 応答が来るまで多重入力を防ぐ
    G.net.send({ t: 'action', action });
    render();                // busy 反映（ボタン無効化など）
    return;
  }
  // --- ローカル(CPU)モード：従来どおり ---
  const res = applyAction(G.game, action);
  if (!res.ok) { render(); return; } // 不正手は無視（描画だけ更新）
  render();
  if (G.game.phase === 'gameover') { showOverlay(); return; }
  if (G.game.active === G.foeSeat && !G.busy) runCpuTurn();
}

async function runCpuTurn() {
  G.busy = true;
  document.body.classList.add('busy');
  render();
  await sleep(500);
  let guard = 0;
  while (G.game.phase === 'playing' && G.game.active === G.foeSeat && guard++ < 80) {
    const action = aiNextAction(G.game);
    if (action.type === 'ATTACK') G.flash = { side: 'foe', index: action.from, type: 'atk' };
    const res = applyAction(G.game, action);
    if (!res.ok) break; // 想定外：止める
    render();
    await sleep(action.type === 'END_TURN' ? 200 : 520);
  }
  G.busy = false;
  document.body.classList.remove('busy');
  render();
  if (G.game.phase === 'gameover') showOverlay();
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
function render() {
  const g = G.game;
  if (!g) return;
  renderTurnIndicator();
  renderLeader('foe-leader', G.foeSeat);
  renderLeader('me-leader', G.mySeat);
  renderBoard('foe-board', G.foeSeat, 'foe');
  renderBoard('me-board', G.mySeat, 'me');
  renderPile('foe-pile', G.foeSeat);
  renderPile('me-pile', G.mySeat);
  renderHand();
  renderLog();
  $('end-turn').disabled = !isMyTurn();
  applyFlash();
}

function renderTurnIndicator() {
  const g = G.game;
  const seatLabel = (seat) => seat === g.firstPlayer ? '先攻' : '後攻';
  const whoCls = g.active === G.mySeat ? 'me' : 'foe';
  const whoTxt = g.active === G.mySeat ? 'あなた' : G.foeLabel;
  $('turn-indicator').innerHTML =
    `ターン ${g.turnNumber}　手番: <span class="${whoCls}">${whoTxt}</span>`
    + `<span style="opacity:.6"> （あなた=${seatLabel(G.mySeat)}）</span>`;
}

function renderLeader(elId, seat) {
  const g = G.game;
  const p = g.players[seat];
  const who = seat === G.mySeat ? 'あなた' : G.foeLabel;
  const role = seat === g.firstPlayer ? '先攻' : '後攻';
  const pct = Math.max(0, (p.hp / LEADER_HP) * 100);
  let pips = '';
  for (let i = 0; i < MAX_MANA; i++) {
    pips += `<span class="pip ${i < p.mana ? '' : 'empty'}">${i < p.maxMana ? '◆' : '◇'}</span>`;
  }
  $(elId).innerHTML = `
    <div class="who">${who}<span style="opacity:.6;font-weight:400;font-size:11px"> (${role})</span></div>
    <div class="hp-wrap"><div class="hp-bar" style="width:${pct}%"></div>
      <div class="hp-text">♥ ${p.hp} / ${LEADER_HP}</div></div>
    <div class="mana">マナ ${p.mana}/${p.maxMana}<br>${pips}</div>`;
}

function renderBoard(elId, seat, side) {
  const g = G.game;
  const board = g.players[seat].board;
  const lit = new Set();
  for (const line of completedLines(board)) for (const i of line) lit.add(i);

  let html = '';
  for (let i = 0; i < BOARD_SIZE; i++) {
    const s = board[i];
    const classes = ['cell'];
    if (lit.has(i)) classes.push('lit', side);

    // 入力ヒント（自分のターン・自分の盤面のみ）
    if (side === 'me' && isMyTurn()) {
      if (G.sel && (G.sel.mode === 'place' || G.sel.mode === 'repoTo') && s == null) classes.push('placeable');
      else if (G.sel && G.sel.mode === 'repoFrom' && s != null) classes.push('movable');
      else if (!G.sel && hasValidAttack(g, seat, i)) classes.push('attacker');
    }

    html += `<div class="${classes.join(' ')}" data-index="${i}" data-side="${side}">`;
    if (s) html += statueHTML(board, i, seat);
    html += `</div>`;
  }
  $(elId).innerHTML = html;
}

function statueHTML(board, i, seat) {
  const s = board[i];
  const eff = effectiveAtk(board, i);
  const boosted = eff > s.atk;
  const hurt = s.hp < s.maxHp;
  const name = SHORT[s.cardId] || s.name;
  const kw = s.keywords.map((k) => KW_ICON[k] || '').join('');
  // 召喚酔い（自分の手番で攻撃不可な新規召喚）の表示
  const sick = seat === G.game.active
    && s.summonedTurn === G.game.turnNumber
    && !s.keywords.includes('speed') && !s.keywords.includes('leader');
  return `
    <div class="statue ${sick ? 'sick' : ''}">
      <div class="s-name">${name}</div>
      <div class="s-stats">
        <span class="atk ${boosted ? 'boosted' : ''}">${eff}</span>/<span class="hp ${hurt ? 'hurt' : ''}">${s.hp}</span>
      </div>
      ${kw ? `<div class="s-kw">${kw}</div>` : ''}
    </div>`;
}

function renderPile(elId, seat) {
  const p = G.game.players[seat];
  $(elId).innerHTML = `
    <div>手札<br><span class="num">${p.hand.length}</span></div>
    <div>山札<br><span class="num">${p.deck.length}</span></div>`;
}

function renderHand() {
  const g = G.game;
  const me = g.players[G.mySeat];
  let html = '';
  for (const inst of me.hand) {
    const card = CARD_DB[inst.cardId];
    const affordable = isMyTurn() && card.cost <= me.mana;
    const selected = G.sel && G.sel.iid === inst.instanceId;
    const cls = ['card'];
    if (!affordable) cls.push('unplayable');
    if (selected) cls.push('selected');

    let body, kw = '';
    if (card.type === 'statue') {
      body = `<div class="c-stats"><span class="a">${card.atk}</span>/<span class="h">${card.hp}</span></div>`;
      if (card.keywords.length) kw = `<div class="c-kw">${card.text}</div>`;
    } else {
      body = `<div class="c-spell">呪文</div>`;
    }
    const text = card.type === 'spell' ? `<div class="c-text">${card.text}</div>` : (kw || `<div class="c-text">${card.text}</div>`);
    html += `
      <div class="${cls.join(' ')}" data-iid="${inst.instanceId}">
        <div class="c-cost">${card.cost}</div>
        <div class="c-name">${card.name}</div>
        <div class="c-body">${body}</div>
        ${text}
      </div>`;
  }
  $('hand').innerHTML = html;
}

let lastLogLen = 0;
function renderLog() {
  const log = G.game.log;
  const el = $('log');
  el.innerHTML = log.map((line, idx) =>
    `<div class="entry ${idx >= lastLogLen ? 'fresh' : ''}">${line}</div>`).join('');
  lastLogLen = log.length;
  el.scrollTop = el.scrollHeight;
}

function applyFlash() {
  if (!G.flash) return;
  const { side, index } = G.flash;
  G.flash = null;
  const boardId = side === 'me' ? 'me-board' : 'foe-board';
  const foeBoardId = side === 'me' ? 'foe-board' : 'me-board';
  const src = $(boardId).querySelector(`.cell[data-index="${index}"]`);
  const tgt = $(foeBoardId).querySelector(`.cell[data-index="${index}"]`);
  if (src) { src.classList.add('flash-atk'); setTimeout(() => src.classList.remove('flash-atk'), 320); }
  if (tgt) { tgt.classList.add('flash-hit'); setTimeout(() => tgt.classList.remove('flash-hit'), 320); }
}

function showOverlay() {
  const win = G.game.winner === G.mySeat;
  $('overlay-msg').textContent = win ? '🏆 あなたの勝ち！' : '💀 あなたの負け…';
  // 再戦ボタンの文言/状態をモードに合わせて復元
  const again = $('overlay-again');
  again.classList.remove('hidden');
  again.disabled = false;
  again.textContent = G.mode === 'online' ? 'もう一度（再戦）' : 'もう一度';
  const lobbyBtn = $('overlay-lobby');
  if (lobbyBtn) lobbyBtn.classList.toggle('hidden', G.mode !== 'online');
  $('overlay').classList.remove('hidden');
}
