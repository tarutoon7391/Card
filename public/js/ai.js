// ===========================================================================
// ai.js — CPU の思考（greedy）。engine の純粋関数だけを使う。
//
// aiNextAction(state) は「今この瞬間に取る 1 アクション」を返す。
// UI 側がこれを applyAction で適用 → 再描画 → 少し待つ、を END_TURN まで繰り返す。
// 1アクションごとに必ず state が前進する（手札 or マナ減少 / 攻撃済みフラグ）ので停止する。
// ===========================================================================

import { CARD_DB } from './cards.js';
import {
  BOARD_SIZE, completedLines, reachCount, effectiveAtk, hasValidAttack,
  adjacentCells,
} from './engine.js';

function emptyCells(board) {
  const out = [];
  for (let i = 0; i < BOARD_SIZE; i++) if (board[i] == null) out.push(i);
  return out;
}
function occupiedCells(board) {
  const out = [];
  for (let i = 0; i < BOARD_SIZE; i++) if (board[i] != null) out.push(i);
  return out;
}

// 盤面を仮想的にいじって「完成ライン数 / リーチ数」を測るための簡易シミュレーション
function simWithStatue(board, index) {
  const b = board.slice();
  b[index] = { dummy: true };
  return b;
}
function simMove(board, from, to) {
  const b = board.slice();
  b[to] = b[from];
  b[from] = null;
  return b;
}

// 最も「効いている」敵（実効攻撃力が高い敵）の座標
function strongestFoe(foeBoard, minAtk = 0) {
  let best = null;
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (foeBoard[i] == null) continue;
    const a = effectiveAtk(foeBoard, i);
    if (a < minAtk) continue;
    if (!best || a > best.a) best = { i, a };
  }
  return best;
}

export function aiNextAction(state) {
  const seat = state.active;
  const me = state.players[seat];
  const foe = state.players[1 - seat];

  // --- 0) 起動の石：今のマナでは届かないが +1 なら届くカードがあるなら先に使う ---
  const kido = me.hand.find((c) => c.cardId === 'kido');
  if (kido) {
    const wantsMore = me.hand.some((c) => {
      const card = CARD_DB[c.cardId];
      return c.cardId !== 'kido' && card.cost > me.mana && card.cost <= me.mana + 1;
    });
    if (wantsMore) return { type: 'PLAY', instanceId: kido.instanceId };
  }

  // --- 1) プレイ：ライン完成 / リーチを最優先に、除去・展開も候補に ---
  const baseCompleted = completedLines(me.board).length;
  const baseReach = reachCount(me.board);
  const foeCompleted = completedLines(foe.board).length;
  const foeReach = reachCount(foe.board);
  let best = null;
  const consider = (score, action) => {
    if (!best || score > best.score) best = { score, action };
  };

  for (const inst of me.hand) {
    const card = CARD_DB[inst.cardId];
    if (card.cost > me.mana) continue;

    if (card.type === 'statue') {
      for (const cell of emptyCells(me.board)) {
        const b = simWithStatue(me.board, cell);
        const gainC = completedLines(b).length - baseCompleted;
        const gainR = reachCount(b) - baseReach;
        // 前線に敵がいて倒せそうなら加点／リーダーアタッカーで空きならリーダー直撃の布石
        let combat = 0;
        const foeUnit = foe.board[cell];
        if (foeUnit) {
          if (card.atk >= foeUnit.hp) combat += 6;     // 即撃破できる位置
        } else if (card.keywords.includes('leader')) {
          combat += 4;                                  // 空き前線→リーダー狙い
        }
        const score = 1000 * gainC + 60 * gainR + combat + card.atk + 1;
        consider(score, { type: 'PLAY', instanceId: inst.instanceId, index: cell });
      }
      continue;
    }

    // --- 呪文 ---
    switch (card.spell) {
      case 'reposition': { // 自分の石像をライン完成/リーチが伸びる空きへ
        for (const from of occupiedCells(me.board)) {
          for (const to of emptyCells(me.board)) {
            const b = simMove(me.board, from, to);
            const gainC = completedLines(b).length - baseCompleted;
            const gainR = reachCount(b) - baseReach;
            if (gainC > 0 || gainR > 0) {
              consider(1000 * gainC + 60 * gainR - 30, { type: 'PLAY', instanceId: inst.instanceId, from, to });
            }
          }
        }
        break;
      }
      case 'twins': { // 別々の2マスへ1/1。ライン/リーチが最大化する組を選ぶ
        const empties = emptyCells(me.board);
        if (empties.length < 2) break;
        for (let x = 0; x < empties.length; x++) {
          for (let y = x + 1; y < empties.length; y++) {
            let b = simWithStatue(me.board, empties[x]);
            b = simWithStatue(b, empties[y]);
            const gainC = completedLines(b).length - baseCompleted;
            const gainR = reachCount(b) - baseReach;
            consider(1000 * gainC + 60 * gainR + 6, { type: 'PLAY', instanceId: inst.instanceId, cells: [empties[x], empties[y]] });
          }
        }
        break;
      }
      case 'destroy': { // 崩落：脅威の敵を破壊（atk2以上）
        const t = strongestFoe(foe.board, 2);
        if (t) consider(130 + t.a * 30, { type: 'PLAY', instanceId: inst.instanceId, target: t.i });
        break;
      }
      case 'weaken': { // 風化：強い敵の攻撃力を削る（atk3以上）
        const t = strongestFoe(foe.board, 3);
        if (t) consider(90 + t.a * 10, { type: 'PLAY', instanceId: inst.instanceId, target: t.i });
        break;
      }
      case 'push': { // 突き飛ばし：敵の完成ライン/リーチを崩せるときだけ
        for (const from of occupiedCells(foe.board)) {
          for (const to of adjacentCells(from)) {
            if (foe.board[to] != null) continue;
            const b = simMove(foe.board, from, to);
            const breakC = foeCompleted - completedLines(b).length;
            const breakR = foeReach - reachCount(b);
            if (breakC > 0 || breakR > 0) {
              consider(300 * breakC + 40 * breakR, { type: 'PLAY', instanceId: inst.instanceId, target: from, to });
            }
          }
        }
        break;
      }
      case 'wake': { // 目覚めの号令：召喚酔いの味方が同座標の敵を倒せるなら起こす
        for (let i = 0; i < BOARD_SIZE; i++) {
          const s = me.board[i];
          if (!s) continue;
          const sick = s.summonedTurn === state.turnNumber
            && !s.keywords.includes('speed') && !s.keywords.includes('leader');
          if (!sick || s.hasAttacked) continue;
          const foeUnit = foe.board[i];
          if (foeUnit && effectiveAtk(me.board, i) >= foeUnit.hp) {
            consider(150, { type: 'PLAY', instanceId: inst.instanceId, target: i });
            break;
          }
        }
        break;
      }
      // saiki(再起)・ishikabe(守護) は局面依存が強いので CPU は温存（持ったまま）
      default:
        break;
    }
  }
  if (best && best.score > 0) return best.action;

  // --- 2) 攻撃：撃破(貫通) > リーダー直撃 > チップ の優先度で1体ずつ ---
  let bestAtk = null;
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (!hasValidAttack(state, seat, i)) continue;
    const A = effectiveAtk(me.board, i);
    const target = foe.board[i];
    let priority;
    if (target) {
      if (A >= target.hp) priority = 100 + (A - target.hp + 1); // 撃破＋貫通量
      else priority = 10 + A;                                   // チップ
    } else {
      priority = 70 + A; // リーダー直撃（leaderキーワード）
    }
    if (!bestAtk || priority > bestAtk.priority) {
      bestAtk = { priority, action: { type: 'ATTACK', from: i } };
    }
  }
  if (bestAtk) return bestAtk.action;

  // --- 3) もう何もできない ---
  return { type: 'END_TURN' };
}
