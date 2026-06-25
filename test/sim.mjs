// AI vs AI 全自動対戦シミュレーション。
// 目的: engine + ai が破綻なく1ゲーム完走できるか（要件の最優先項目）、
//       および先攻/後攻の勝率バランスをざっくり見る。
// 実行: node test/sim.mjs [games]

import { createGame, applyAction } from '../public/js/engine.js';
import { aiNextAction } from '../public/js/ai.js';

const GAMES = Number(process.argv[2] || 400);
const MAX_ACTIONS = 4000; // 無限ループ検知用の安全弁

let firstWins = 0, secondWins = 0, draws = 0;
let totalTurns = 0, maxTurns = 0, stuck = 0, crashed = 0;

for (let n = 0; n < GAMES; n++) {
  const seed = (1000 + n * 7919) >>> 0;
  const g = createGame({ seed });
  let acts = 0;
  try {
    while (g.phase === 'playing' && acts < MAX_ACTIONS) {
      const a = aiNextAction(g);
      const r = applyAction(g, a);
      acts++;
      if (!r.ok) { // 不正手をAIが出した = バグ
        console.error(`game ${n}: 不正手 ${JSON.stringify(a)} -> ${r.reason}`);
        stuck++; break;
      }
    }
  } catch (e) {
    crashed++;
    console.error(`game ${n}: 例外 ${e.message}`);
    continue;
  }
  if (g.phase !== 'gameover') { stuck++; continue; }
  totalTurns += g.turnNumber;
  maxTurns = Math.max(maxTurns, g.turnNumber);
  if (g.winner === g.firstPlayer) firstWins++; else secondWins++;
}

const decided = firstWins + secondWins;
console.log(`対戦数: ${GAMES}`);
console.log(`完走: ${decided}  / 未決着(stuck): ${stuck}  / 例外: ${crashed}`);
if (decided > 0) {
  console.log(`先攻勝率: ${(firstWins / decided * 100).toFixed(1)}%  (${firstWins})`);
  console.log(`後攻勝率: ${(secondWins / decided * 100).toFixed(1)}%  (${secondWins})`);
  console.log(`平均ターン数: ${(totalTurns / decided).toFixed(1)}  / 最長: ${maxTurns}`);
}
process.exit(stuck === 0 && crashed === 0 ? 0 : 1);
