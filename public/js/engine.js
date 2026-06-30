// ===========================================================================
// engine.js — ゲームの純粋ロジック（DOM・乱数源・描画に一切依存しない）
//
// 状態はすべてプレーンオブジェクト。applyAction(state, action) が唯一の入口で、
// アクションを検証して state を進め、発生したイベントを返す。
// この純粋さのおかげで、サーバー権威マルチプレイへそのまま移植できる
// （サーバーが state を持ち、各クライアントは action を送るだけ）。
//
// 効果の処理順（要件）: 召喚時効果 → ライン完成判定 → 攻撃力再計算。
//   攻撃力は effectiveAtk で常に動的計算なので「再計算」は暗黙。
//   盤面が動く操作のあとは必ず recomputeLines を呼び、ライン完成トリガを処理する。
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

// 直交で隣接するマス（押し引き・召喚時移動で使う）
export function adjacentCells(i) {
  const r = Math.floor(i / 3), c = i % 3;
  const out = [];
  if (r > 0) out.push(i - 3);
  if (r < 2) out.push(i + 3);
  if (c > 0) out.push(i - 1);
  if (c < 2) out.push(i + 1);
  return out;
}

function isEmpty(board, i) {
  return i != null && i >= 0 && i < BOARD_SIZE && board[i] == null;
}

// 盤上で石像を from → to へ移動（pos を更新）
function moveStatue(board, from, to) {
  const s = board[from];
  board[to] = s;
  board[from] = null;
  if (s) s.pos = to;
}

// ライン完成/リーチを最大化する空きマスを1つ選ぶ（トークン自動配置・CPU用）
function pickLineEmptyCell(board) {
  let best = null;
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (board[i] != null) continue;
    const b = board.slice();
    b[i] = { dummy: true };
    const score = completedLines(b).length * 100 + reachCount(b);
    if (best == null || score > best.score) best = { i, score };
  }
  return best ? best.i : null;
}

// 引き寄せ対象（最も攻撃力の高い敵）を自動で選ぶ
function pickStrongestStatue(board) {
  let best = null;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const s = board[i];
    if (!s) continue;
    if (best == null || s.atk > best.atk) best = { i, atk: s.atk };
  }
  return best ? best.i : null;
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
    lineDone: [],               // 現在完成しているライン（LINES のインデックス）
    linesCompletedThisTurn: 0,  // このターンに新規完成したライン本数（ラインロード用）
  };
}

function newInstance(state, cardId) {
  return { instanceId: state.nextInstanceId++, cardId };
}

// 盤上の石像オブジェクトを生成。instanceId は手札カード由来 or トークン用に新規発行。
function makeStatue(state, card, seat, index, instanceId) {
  return {
    instanceId: instanceId != null ? instanceId : state.nextInstanceId++,
    cardId: card.id,
    name: card.name,
    atk: card.atk,
    hp: card.hp,
    maxHp: card.hp,
    keywords: [...(card.keywords || [])],
    owner: seat,
    pos: index,
    summonedTurn: state.turnNumber,
    hasAttacked: false,
    shield: false,        // 守護の石壁: 1回だけ破壊を耐える
    triggeredLines: [],   // ライン完成トリガ済みの LINES インデックス
  };
}

// 1/1 トークン（石兵）を召喚。双子の歩兵・増殖兵・連鎖の旗兵が使う。
function spawnToken(state, seat, index, events) {
  const p = state.players[seat];
  if (!isEmpty(p.board, index)) return null;
  const s = makeStatue(state, CARD_DB.token, seat, index);
  p.board[index] = s;
  events.push({ kind: 'summon', seat, index, cardId: 'token', log: `${seatName(state, seat)}：石兵を ${cellName(index)} に召喚` });
  return s;
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
  // 注: セットアップ中のイベント（draw/turnStart）はログに残さないので、
  //     state.log ではなく使い捨て配列へ流す（さもないとログに [object Object] が混ざる）。
  const setupEvents = [];
  for (const p of state.players) {
    p.deck = shuffle(buildDeck(), rng); // cardId 配列（末尾がトップ）
    for (let i = 0; i < START_HAND; i++) drawCard(state, p, setupEvents);
  }
  // 後攻だけ「起動の石」を初期手札へ
  const secondSeat = 1 - first;
  state.players[secondSeat].hand.push(newInstance(state, 'kido'));

  // 先攻ターン1の開始処理（マナ+1、ただしドローなし）
  state.active = first;
  state.turnNumber = 1;
  startTurn(state, setupEvents);

  return state;
}

// ---------------------------------------------------------------------------
// ターン進行
// ---------------------------------------------------------------------------

function startTurn(state, events) {
  const p = state.players[state.active];
  p.maxMana = Math.min(MAX_MANA, p.maxMana + 1);
  p.mana = p.maxMana;
  p.linesCompletedThisTurn = 0;
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
// ライン完成トリガの処理（盤面が動いたら毎回呼ぶ）
//   ・整列兵(trigger:'draw') … 自分を含むラインが完成するたび1ドロー
//   ・連鎖の旗兵(trigger:'spawn') … 同上で石兵を召喚（1ターン1回）
//   ・linesCompletedThisTurn を更新（ラインロードのバーン用）
// 石像ごとに「発火済みライン」を覚え、崩れたら忘れる＝再成立で再発火する。
// ---------------------------------------------------------------------------
function recomputeLines(state, events) {
  let guard = 0, changed = true;
  while (changed && guard++ < 40) {
    changed = false;
    for (const p of state.players) {
      const completedIdx = [];
      LINES.forEach((line, k) => { if (line.every((i) => p.board[i] != null)) completedIdx.push(k); });

      // 盤面レベルの新規完成をカウント（ラインロード用）
      const prevDone = p.lineDone || [];
      for (const k of completedIdx) if (!prevDone.includes(k)) p.linesCompletedThisTurn += 1;
      p.lineDone = completedIdx;

      // 石像ごとのライン完成トリガ
      for (let idx = 0; idx < BOARD_SIZE; idx++) {
        const s = p.board[idx];
        if (!s) continue;
        const card = CARD_DB[s.cardId];
        if (!card || !card.trigger) continue;
        const myLines = completedIdx.filter((k) => LINES[k].includes(idx));
        s.triggeredLines = (s.triggeredLines || []).filter((k) => myLines.includes(k)); // 崩れた分を忘れる
        for (const k of myLines) {
          if (s.triggeredLines.includes(k)) continue;
          s.triggeredLines.push(k); // 同じラインで二重発火しない
          if (card.trigger === 'draw') {
            drawCard(state, p, events);
            events.push({ kind: 'lineDraw', seat: p.seat, log: `${seatName(state, p.seat)}：${s.name} のライン完成 → 1ドロー` });
          } else if (card.trigger === 'spawn') {
            if (s.chainLastTurn === state.turnNumber) continue; // 1ターン1回
            const cell = pickLineEmptyCell(p.board);
            if (cell == null) continue;
            spawnToken(state, p.seat, cell, events);
            s.chainLastTurn = state.turnNumber;
            events.push({ kind: 'lineSpawn', seat: p.seat, log: `${seatName(state, p.seat)}：${s.name} のライン完成 → 石兵を召喚` });
            changed = true; // 盤面が増えたので再判定
          }
        }
      }
    }
  }
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
  let res;
  if (card.type === 'statue') {
    res = playStatue(state, action, card, inst, events);
  } else {
    res = playSpell(state, action, card, inst, events);
  }
  if (!res.ok) return res; // 検証失敗：state は未変更（各ハンドラが変更前に検証する）

  // 共通後処理: コスト・手札・ライン再判定・勝敗
  p.mana -= card.cost;
  p.hand.splice(handIdx, 1);
  recomputeLines(state, events);
  // 終撃のラインロード: バーンは「ライン完成判定の後」に解決する。
  //   こうすることで“自身の召喚で完成させたライン”も本数に含めて締められる。
  //   （他の召喚時効果はライン判定の前に処理する＝burn だけ後回しの特例）
  if (res.statue && CARD_DB[res.statue.cardId].summon === 'burn') {
    const me = state.players[seat];
    const foe = state.players[1 - seat];
    const n = me.linesCompletedThisTurn || 0;
    if (n > 0) {
      foe.hp -= n * 2;
      const lcard = CARD_DB[res.statue.cardId];
      events.push({ kind: 'burn', seat, amount: n * 2, log: `${seatName(state, seat)}：${lcard.name} で ${n} ライン×2 = ${n * 2} ダメージ` });
    }
  }
  checkWin(state, events);
  commit(state, events);
  return { ok: true, events };
}

// --- 石像の召喚（＋召喚時効果） ---
function playStatue(state, action, card, inst, events) {
  const seat = state.active;
  const p = state.players[seat];
  const i = action.index;
  if (i == null || i < 0 || i >= BOARD_SIZE) return fail('配置先が不正');
  if (p.board[i] != null) return fail('そのマスは埋まっている');

  const s = makeStatue(state, card, seat, i, inst.instanceId);
  p.board[i] = s;
  events.push({ kind: 'summon', seat, index: i, cardId: card.id, log: `${seatName(state, seat)}：${card.name} を ${cellName(i)} に召喚` });

  // 召喚時効果（ライン判定の前に処理する。burn だけは playCard 側で後処理）
  runSummonEffect(state, seat, s, action, events);
  return { ok: true, statue: s };
}

function runSummonEffect(state, seat, statue, action, events) {
  const card = CARD_DB[statue.cardId];
  const me = state.players[seat];
  const foe = state.players[1 - seat];
  switch (card.summon) {
    case 'burn': // 終撃のラインロード: バーンは playCard 側で「ライン判定の後」に解決する
      break;
    case 'copyRight': { // 増殖兵: 右隣が空きなら1/1コピー
      const i = statue.pos;
      if (i % 3 < 2 && isEmpty(me.board, i + 1)) {
        spawnToken(state, seat, i + 1, events);
      }
      break;
    }
    case 'move': { // 疾走の伝令: 味方1体を隣接する空きマスへ（任意）
      const { moveFrom, moveTo } = action;
      if (moveFrom != null && moveTo != null
        && me.board[moveFrom] != null && isEmpty(me.board, moveTo)
        && adjacentCells(moveFrom).includes(moveTo)) {
        moveStatue(me.board, moveFrom, moveTo);
        events.push({ kind: 'move', seat, from: moveFrom, to: moveTo, log: `${seatName(state, seat)}：${card.name} で味方を移動（${cellName(moveFrom)} → ${cellName(moveTo)}）` });
      }
      break;
    }
    case 'pull': { // 鉤縄の番兵: 敵1体を正面（同座標）へ引き寄せる ※正面が空きのとき
      const front = statue.pos;
      if (isEmpty(foe.board, front)) {
        let from = action.pull;
        if (from == null || foe.board[from] == null) from = pickStrongestStatue(foe.board);
        if (from != null && foe.board[from] != null && from !== front) {
          moveStatue(foe.board, from, front);
          events.push({ kind: 'pull', seat, from, to: front, log: `${seatName(state, seat)}：${card.name} で敵を正面（${cellName(front)}）へ引き寄せ` });
        }
      }
      break;
    }
    default: break;
  }
}

// --- 呪文 ---
function playSpell(state, action, card, inst, events) {
  const seat = state.active;
  const me = state.players[seat];
  const foe = state.players[1 - seat];

  switch (card.spell) {
    case 'mana': { // 起動の石
      me.mana += 1; // この時点で +1（後処理の cost 減算は 0）
      events.push({ kind: 'mana', seat, log: `${seatName(state, seat)}：起動の石（マナ +1）` });
      return { ok: true };
    }
    case 'reposition': { // 再配置
      const { from, to } = action;
      if (me.board[from] == null) return fail('移動元に自分の石像がない');
      if (!isEmpty(me.board, to)) return fail('移動先が空きマスでない');
      moveStatue(me.board, from, to);
      events.push({ kind: 'reposition', seat, from, to, log: `${seatName(state, seat)}：再配置（${cellName(from)} → ${cellName(to)}）` });
      return { ok: true };
    }
    case 'twins': { // 双子の歩兵: 1/1を2体、別々の空きマスへ
      const cells = action.cells || [];
      if (cells.length !== 2 || cells[0] === cells[1]) return fail('召喚先を2マス指定する');
      if (!isEmpty(me.board, cells[0]) || !isEmpty(me.board, cells[1])) return fail('召喚先が空きマスでない');
      spawnToken(state, seat, cells[0], events);
      spawnToken(state, seat, cells[1], events);
      return { ok: true };
    }
    case 'push': { // 突き飛ばし: 敵1体を隣接する空きマスへ
      const { target, to } = action;
      if (target == null || foe.board[target] == null) return fail('押す敵を指定する');
      if (!isEmpty(foe.board, to)) return fail('押し先が空きマスでない');
      if (!adjacentCells(target).includes(to)) return fail('隣接マスではない');
      moveStatue(foe.board, target, to);
      events.push({ kind: 'push', seat, from: target, to, log: `${seatName(state, seat)}：突き飛ばし（${cellName(target)} → ${cellName(to)}）` });
      return { ok: true };
    }
    case 'wake': { // 目覚めの号令: 召喚酔いを解除
      const t = action.target;
      if (t == null || me.board[t] == null) return fail('対象の味方がいない');
      me.board[t].summonedTurn = 0; // 過去ターン扱い＝酔い解除
      events.push({ kind: 'wake', seat, index: t, log: `${seatName(state, seat)}：${me.board[t].name} の召喚酔いを解除` });
      return { ok: true };
    }
    case 'reattack': { // 再起の鼓動: もう一度攻撃可
      const t = action.target;
      if (t == null || me.board[t] == null) return fail('対象の味方がいない');
      me.board[t].hasAttacked = false;
      events.push({ kind: 'reattack', seat, index: t, log: `${seatName(state, seat)}：${me.board[t].name} は再攻撃できる` });
      return { ok: true };
    }
    case 'shield': { // 守護の石壁: 1回だけ破壊を耐える
      const t = action.target;
      if (t == null || me.board[t] == null) return fail('対象の味方がいない');
      me.board[t].shield = true;
      events.push({ kind: 'shield', seat, index: t, log: `${seatName(state, seat)}：${me.board[t].name} に守護の石壁` });
      return { ok: true };
    }
    case 'weaken': { // 風化: 敵の攻撃力 -2（0未満にしない・永続）
      const t = action.target;
      if (t == null || foe.board[t] == null) return fail('対象の敵がいない');
      const s = foe.board[t];
      s.atk = Math.max(0, s.atk - 2);
      events.push({ kind: 'weaken', seat, index: t, log: `${seatName(state, seat)}：風化で ${s.name} の攻撃力 -2（→ ${s.atk}）` });
      return { ok: true };
    }
    case 'destroy': { // 崩落: 敵を破壊（貫通なし。守護で耐える）
      const t = action.target;
      if (t == null || foe.board[t] == null) return fail('対象の敵がいない');
      const s = foe.board[t];
      if (s.shield) {
        s.shield = false;
        events.push({ kind: 'shieldSave', seat, index: t, log: `${seatName(state, seat)}：崩落を ${s.name} が守護で耐えた` });
      } else {
        foe.board[t] = null;
        events.push({ kind: 'destroy', seat, index: t, log: `${seatName(state, seat)}：崩落で ${s.name} を破壊` });
      }
      return { ok: true };
    }
    default:
      return fail('未対応のカード');
  }
}

// --- 攻撃（一方通行＋貫通） ---
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
    // 反撃（返しの石像）は被弾前の実効攻撃力で計算しておく
    const counterDmg = target.keywords.includes('counter') ? effectiveAtk(foe.board, i) : 0;
    const before = target.hp; // 殴った瞬間の残りHP
    target.hp -= A;

    if (target.hp <= 0 && target.shield) {
      // 守護の石壁: 致死を1回だけ耐える（HP1で残る＝撃破されない＝貫通なし）
      target.hp = 1;
      target.shield = false;
      events.push({ kind: 'shieldSave', seat, index: i, log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) の攻撃を ${target.name} が守護で耐えた` });
      if (counterDmg > 0) applyCounter(state, seat, i, counterDmg, target, events);
    } else if (target.hp <= 0) {
      const pierce = Math.max(0, A - before + 1); // 貫通 = 攻撃力 - 直前HP + 1
      foe.board[i] = null;
      foe.hp -= pierce;
      events.push({
        kind: 'attack', seat, index: i, killed: true, pierce, atk: A,
        log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が ${cellName(i)} の敵を撃破 → 貫通 ${pierce} ダメージ`,
      });
      // 撃破された場合は反撃しない
    } else {
      events.push({
        kind: 'attack', seat, index: i, killed: false, atk: A,
        log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が ${cellName(i)} の敵に ${A} ダメージ（残HP ${target.hp}）`,
      });
      if (counterDmg > 0) applyCounter(state, seat, i, counterDmg, target, events);
    }
  } else {
    // 空座標 → リーダーアタッカーのみ（hasValidAttack で保証済み）
    foe.hp -= A;
    events.push({
      kind: 'leaderHit', seat, index: i, atk: A,
      log: `${seatName(state, seat)}：${atkStatue.name}(攻${A}) が相手リーダーへ ${A} ダメージ`,
    });
  }

  if (atkStatue.owner === seat && me.board[i] === atkStatue) atkStatue.hasAttacked = true;
  recomputeLines(state, events);
  checkWin(state, events);
  commit(state, events);
  return { ok: true, events };
}

// 返しの石像の反撃（一方通行の例外）。殴ってきた石像へダメージ。
// 致死なら破壊（貫通なし）。守護があれば1回耐える。
function applyCounter(state, attackerSeat, idx, dmg, counterStatue, events) {
  const me = state.players[attackerSeat];
  const s = me.board[idx];
  if (!s) return;
  s.hp -= dmg;
  if (s.hp <= 0) {
    if (s.shield) {
      s.hp = 1;
      s.shield = false;
      events.push({ kind: 'shieldSave', seat: attackerSeat, index: idx, log: `${seatName(state, attackerSeat)}：${counterStatue.name} の反撃を ${s.name} が守護で耐えた` });
    } else {
      me.board[idx] = null;
      events.push({ kind: 'counterKill', seat: attackerSeat, index: idx, dmg, log: `${counterStatue.name} の反撃 ${dmg} で ${s.name} を撃破` });
    }
  } else {
    events.push({ kind: 'counter', seat: attackerSeat, index: idx, dmg, log: `${counterStatue.name} が反撃 ${dmg}（${s.name} 残HP ${s.hp}）` });
  }
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

// ---------------------------------------------------------------------------
// サーバー権威オンライン用：指定 seat の視点で state を直列化する。
//   - 盤面（board）は公開情報なので両者ぶんそのまま送る
//   - 自分の手札は中身込み、相手の手札は枚数だけ（null 埋め＝中身を隠す）
//   - 山札は両者とも枚数だけ（次の引きを予測されないよう中身を隠す）
//   - seed / rng はクライアントへ送らない（決定的乱数を再現されると不正の元）
// クライアント側 ui.js は p.hand / p.deck の length しか触らない（相手手札は描画しない）
// ので、null 埋め配列でそのまま描画ロジックが動く。
// ---------------------------------------------------------------------------
export function serializeFor(state, seat) {
  const players = state.players.map((p) => ({
    seat: p.seat,
    hp: p.hp,
    maxMana: p.maxMana,
    mana: p.mana,
    board: p.board,
    hand: p.seat === seat
      ? p.hand.map((c) => ({ instanceId: c.instanceId, cardId: c.cardId }))
      : new Array(p.hand.length).fill(null),
    deck: new Array(p.deck.length).fill(null),
  }));
  return {
    active: state.active,
    turnNumber: state.turnNumber,
    firstPlayer: state.firstPlayer,
    phase: state.phase,
    winner: state.winner,
    log: state.log.slice(),
    players,
  };
}
function cellName(i) {
  const rows = ['上', '中', '下'];
  const cols = ['左', '中', '右'];
  return rows[Math.floor(i / 3)] + cols[i % 3];
}
