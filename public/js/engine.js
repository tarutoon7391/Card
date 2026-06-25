// ===========================================================================
// engine.js — ゲームの純粋ロジック（DOM・乱数源・描画に一切依存しない）
//
// 状態はすべてプレーンオブジェクト。applyAction(state, action) が唯一の入口で、
// アクションを検証して state を進め、発生したイベントを返す。
// この純粋さのおかげで、後で Railway 上のサーバー権威マルチプレイへそのまま移植できる
// （サーバーが state を持ち、各クライアントは action を送るだけ）。
// ===========================================================================

import { CARD_DB, DECK_LIST, COPIES_PER_CARD } from './cards.js';

export const BOARD_SIZE = 9; // 3x3
export const LEADER_HP = 20;
export const MAX_MANA = 10;
export const START_HAND = 5;

// 3x3 のライン（行・列・斜め）。インデックスは row*3 + col。
//  0 1 2
//  3 4 5
//  6 7 8
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // 横
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // 縦
  [0, 4, 8], [2, 4, 6],            // 斜め
];

// --- 乱数（シード可能）。サーバー権威でも決定的に再現できるよう自前実装 ---
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// 盤面ヘルパ
// ---------------------------------------------------------------------------

// その盤面で「完成しているライン」（3マスすべて自分の石像）の配列を返す
export function completedLines(board) {
  return LINES.filter((line) => line.every((i) => board[i] != null));
}

// あるマスの石像が含まれる「完成ライン数」= 攻撃力ボーナス
export function lineBonus(board, index) {
  if (board[index] == null) return 0;
  return completedLines(board).filter((line) => line.includes(index)).length;
}

// 実効攻撃力 = 元の攻撃力 + 完成ラインボーナス（常に動的計算）
export function effectiveAtk(board, index) {
  const s = board[index];
  if (!s) return 0;
  return s.atk + lineBonus(board, index);
}

// 「リーチ」= あと1マスで完成するライン（2マス自分・残り1マス空き）の数
export function reachCount(board) {
  let n = 0;
  for (const line of LINES) {
    const filled = line.filter((i) => board[i] != null).length;
    if (filled === 2) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// セットアップ
// ---------------------------------------------------------------------------

function buildDeck() {
  const deck = [];
  for (const id of DECK_LIST) {
    for (let i = 0; i < COPIES_PER_CARD; i++) deck.push(id);
  }
  return deck;
}

function makePlayer(seat) {
  return {
    seat,
    hp: LEADER_HP,
    maxMana: 0,
    mana: 0,
    deck: [],   // cardId の配列（末尾がデッキトップ）
    hand: [],   // { instanceId, cardId } の配列
    board: new Array(BOARD_SIZE).fill(null),
  };
}

function newInstance(state, cardId) {
  return { instanceId: state.nextInstanceId++, cardId };
}

function drawCard(state, player, events) {
  if (player.deck.length === 0) return; // 山札切れ：プロトタイプでは何もしない
  const cardId = player.deck.pop();
  player.hand.push(newInstance(state, cardId));
  events.push({ kind: 'draw', seat: player.seat, cardId });
}

// 新しいゲームを生成。
// opts.seed: 乱数シード / opts.firstSeat: 先攻席を固定したい場合（省略で乱数）
export function createGame(opts = {}) {
  const seed = (opts.seed ?? (Date.now() & 0xffffffff)) >>> 0;
  const rng = mulberry32(seed);

  const state = {
    seed,
    rng,
    nextInstanceId: 1,
    players: [makePlayer(0), makePlayer(1)],
    active: 0,
    firstPlayer: 0,
    turnNumber: 0,
    phase: 'playing', // 'playing' | 'gameover'
    winner: null,
    log: [],
  };

  const first = opts.firstSeat != null ? opts.firstSeat : (rng() < 0.5 ? 0 : 1);
  state.firstPlayer = first;

  // デッキ構築・シャッフル・初期手札
  for (const p of state.players) {
    p.deck = shuffle(buildDeck(), rng); // cardId 配列（末尾がトップ）
    for (let i = 0; i < START_HAND; i++) drawCard(state, p, state.log);
  }
  // 後攻だけ「起動の石」を初期手札へ
  const secondSeat = 1 - first;
  state.players[secondSeat].hand.push(newInstance(state, 'kido'));

  // 先攻ターン1の開始処理（マナ+1、ただしドローなし）
  state.active = first;
  state.turnNumber = 1;
  startTurn(state, state.log);

  return state;
}

// ---------------------------------------------------------------------------
// ターン進行
// ---------------------------------------------------------------------------

function startTurn(state, events) {
  const p = state.players[state.active];
  p.maxMana = Math.min(MAX_MANA, p.maxMana + 1);
  p.mana = p.maxMana;
  // 自分の石像の攻撃済みフラグをリセット
  for (const s of p.board) if (s) s.hasAttacked = false;
  // ドロー（先攻の最初のターン = turnNumber 1 のみスキップ）
  if (state.turnNumber !== 1) drawCard(state, p, events);
  events.push({ kind: 'turnStart', seat: state.active, turn: state.turnNumber });
}

function endTurn(state, events) {
  events.push({ kind: 'turnEnd', seat: state.active });
  state.active = 1 - state.active;
  state.turnNumber += 1;
  startTurn(state, events);
}

// ---------------------------------------------------------------------------
// 攻撃可否
// ---------------------------------------------------------------------------

function isSummoningSick(state, statue) {
  return statue.summonedTurn === state.turnNumber;
}

// その石像が今ターン攻撃「行動」を取れるか（対象の有無は別途）
export function canAct(state, seat, index) {
  const p = state.players[seat];
  const s = p.board[index];
  if (!s) return false;
  if (state.active !== seat) return false;
  if (s.hasAttacked) return false;
  const sick = isSummoningSick(state, s);
  const speedy = s.keywords.includes('speed') || s.keywords.includes('leader');
  if (sick && !speedy) return false;
  return true;
}

// 実際に攻撃できる対象があるか
export function hasValidAttack(state, seat, index) {
  if (!canAct(state, seat, index)) return false;
  const foe = state.players[1 - seat];
  const target = foe.board[index];
  if (target) return true; // 同座標に敵 → 攻撃可
  // 空座標：リーダーアタッカーのみリーダーへ直接攻撃可
  return state.players[seat].board[index].keywords.includes('leader');
}

// ---------------------------------------------------------------------------
// アクション適用（唯一の入口）
// ---------------------------------------------------------------------------

export function applyAction(state, action) {
  if (state.phase !== 'playing') return fail('ゲームは終了している');
  switch (action.type) {
    case 'PLAY': return playCard(state, action);
    case 'ATTACK': return attack(state, action);
    case 'END_TURN': {
      const events = [];
      endTurn(state, events);
      commit(state, events);
      return { ok: true, events };
    }
    default:
      return fail('不明なアクション: ' + action.type);
  }
}

function fail(reason) {
  return { ok: false, reason };
}

function commit(state, events) {
  for (const e of events) if (e.log) state.log.push(e.log);
}

// --- カードプレイ ---
function playCard(state, action) {
  const seat = state.active;
  const p = state.players[seat];
  const handIdx = p.hand.findIndex((c) => c.instanceId === action.instanceId);
  if (handIdx < 0) return fail('手札にそのカードがない');
  const inst = p.hand[handIdx];
  const card = CARD_DB[inst.cardId];
  if (card.cost > p.mana) return fail('マナが足りない');

  const events = [];

  if (card.type === 'statue') {
    const i = action.index;
    if (i == null || i < 0 || i >= BOARD_SIZE) return fail('配置先が不正');
    if (p.board[i] != null) return fail('そのマスは埋まっている');
    p.board[i] = {
      instanceId: inst.instanceId,
      cardId: card.id,
      name: card.name,
      atk: card.atk,
      hp: card.hp,
      maxHp: card.hp,
      keywords: [...card.keywords],
      owner: seat,
      pos: i,
      summonedTurn: state.turnNumber,
      hasAttacked: false,
    };
    p.mana -= card.cost;
    p.hand.splice(handIdx, 1);
    events.push({ kind: 'summon', seat, index: i, cardId: card.id, log: `${seatName(state, seat)}：${card.name} を ${cellName(i)} に召喚` });
  } else if (card.spell === 'reposition') {
    const { from, to } = action;
    if (p.board[from] == null) return fail('移動元に自分の石像がない');
    if (to == null || p.board[to] != null) return fail('移動先が空きマスでない');
    const s = p.board[from];
    p.board[to] = s;
    p.board[from] = null;
    s.pos = to;
    p.mana -= card.cost;
    p.hand.splice(handIdx, 1);
    events.push({ kind: 'reposition', seat, from, to, log: `${seatName(state, seat)}：再配置（${cellName(from)} → ${cellName(to)}）` });
  } else if (card.spell === 'mana') {
    p.mana += 1; // このターンのマナ +1（cost 0）
    p.hand.splice(handIdx, 1);
    events.push({ kind: 'mana', seat, log: `${seatName(state, seat)}：起動の石（マナ +1）` });
  } else {
    return fail('未対応のカード');
  }

  commit(state, events);
  return { ok: true, events };
}

// --- 攻撃（一方通行＋貫通）---
function attack(state, action) {
  const seat = state.active;
  const i = action.from;
  if (!hasValidAttack(state, seat, i)) return fail('その石像は攻撃できない');

  const me = state.players[seat];
  const foe = state.players[1 - seat];
  const atkStatue = me.board[i];
  const A = effectiveAtk(me.board, i); // 完成ラインボーナス込み
  const target = foe.board[i];
  const events = [];

  if (target) {
    const before = target.hp; // 殴った瞬間の残りHP
    target.hp -= A;
    if (target.hp <= 0) {
      const pierce = Math.max(0, A - before + 1); // 貫通 = 攻撃力 - 直前HP + 1
      foe.board[i] = null;
      foe.hp -= pierce;
      events.push({
        kind: 'attack', seat, index: i, killed: true, pierce, atk: A,
        log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が ${cellName(i)} の敵を撃破 → 貫通 ${pierce} ダメージ`,
      });
    } else {
      events.push({
        kind: 'attack', seat, index: i, killed: false, atk: A,
        log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が ${cellName(i)} の敵に ${A} ダメージ（残HP ${target.hp}）`,
      });
    }
  } else {
    // 空座標 → リーダーアタッカーのみ（hasValidAttack で保証済み）
    foe.hp -= A;
    events.push({
      kind: 'leaderHit', seat, index: i, atk: A,
      log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が相手リーダーへ ${A} ダメージ`,
    });
  }

  atkStatue.hasAttacked = true;
  checkWin(state, events);
  commit(state, events);
  return { ok: true, events };
}

function checkWin(state, events) {
  for (const p of state.players) {
    if (p.hp <= 0) {
      p.hp = Math.max(0, p.hp);
      state.phase = 'gameover';
      state.winner = 1 - p.seat;
      events.push({ kind: 'gameover', winner: state.winner, log: `${seatName(state, state.winner)} の勝利！` });
    }
  }
}

// ---------------------------------------------------------------------------
// 表示用の小ヘルパ（ログ文言）
// ---------------------------------------------------------------------------
function seatName(state, seat) {
  return seat === state.firstPlayer ? '先攻' : '後攻';
}
function cellName(i) {
  const rows = ['上', '中', '下'];
  const cols = ['左', '中', '右'];
  return rows[Math.floor(i / 3)] + cols[i % 3];
}
