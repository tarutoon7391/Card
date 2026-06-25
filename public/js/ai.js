// ===========================================================================
// ai.js — CPU の思考（greedy）。engine の純粋関数だけを使う。
//
// aiNextAction(state) は「今この瞬間に取る 1 アクション」を返す。
// UI 側がこれを applyAction で適用 → 再描画 → 少し待つ、を END_TURN まで繰り返す。
// 1アクションごとに必ず state が前進する（手札 or マナ減少 / 攻撃済みフラグ）ので停止する。
// ===========================================================================

import { CARD_DB } from './cards.js';
import {
  BOARD_SIZE, LINES, completedLines, reachCount, effectiveAtk, hasValidAttack,
} from './engine.js';

function emptyCells(board) {
  const out = [];
  for (let i = 0; i < BOARD_SIZE; i++) if (board[i] == null) out.push(i);
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

  // --- 1) プレイ：ライン完成 / リーチを最優先に、なければ素直に展開 ---
  const baseCompleted = completedLines(me.board).length;
  const baseReach = reachCount(me.board);
  let best = null;

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
        if (!best || score > best.score) {
          best = { score, action: { type: 'PLAY', instanceId: inst.instanceId, index: cell } };
        }
      }
    } else if (card.spell === 'reposition') {
      // ライン完成 / リーチを増やせる移動だけ検討
      const occupied = [];
      for (let i = 0; i < BOARD_SIZE; i++) if (me.board[i]) occupied.push(i);
      for (const from of occupied) {
        for (const to of emptyCells(me.board)) {
          const b = simMove(me.board, from, to);
          const gainC = completedLines(b).length - baseCompleted;
          const gainR = reachCount(b) - baseReach;
          const score = 1000 * gainC + 60 * gainR - 30; // 手札1枚消費するので控えめ
          if (gainC > 0 || gainR > 0) {
            if (!best || score > best.score) {
              best = { score, action: { type: 'PLAY', instanceId: inst.instanceId, from, to } };
            }
          }
        }
      }
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
