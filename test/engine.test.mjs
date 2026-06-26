// engine の純粋ロジック検証（Node で実行: node test/engine.test.mjs）
// DOM 非依存なのでブラウザ無しでコアの正しさを確認できる。

import {
  createGame, applyAction, effectiveAtk, completedLines, lineBonus,
  canAct, hasValidAttack, LINES, serializeFor,
} from '../public/js/engine.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${b}, got ${a})`); }

// --- 盤面ヘルパ用に状態を直接組み立てる小道具 ---
function freshGame(firstSeat = 0) {
  return createGame({ seed: 12345, firstSeat });
}
function putStatue(state, seat, index, { atk, hp, keywords = [], summonedTurn = 0 }) {
  state.players[seat].board[index] = {
    instanceId: 9000 + index, cardId: 'test', name: 'T',
    atk, hp, maxHp: hp, keywords: [...keywords], owner: seat, pos: index,
    summonedTurn, hasAttacked: false,
  };
}

// ===========================================================================
console.log('== セットアップ ==');
{
  const s = freshGame(0);
  eq(s.firstPlayer, 0, '先攻席は0固定');
  eq(s.active, 0, 'アクティブは先攻');
  eq(s.turnNumber, 1, 'ターン1');
  eq(s.players[0].hand.length, 5, '先攻の初期手札5枚');
  // 後攻は5枚+起動の石=6枚
  eq(s.players[1].hand.length, 6, '後攻は起動の石込みで6枚');
  ok(s.players[1].hand.some((c) => c.cardId === 'kido'), '後攻が起動の石を持つ');
  ok(!s.players[0].hand.some((c) => c.cardId === 'kido'), '先攻は起動の石を持たない');
  eq(s.players[0].maxMana, 1, '先攻ターン1の最大マナ1');
  eq(s.players[0].mana, 1, '先攻ターン1のマナ1');
  // 先攻ターン1はドローなし → デッキ20-5=15
  eq(s.players[0].deck.length, 15, '先攻はターン1ドローなしでデッキ15');
}

// ===========================================================================
console.log('== ライン完成と攻撃力ボーナス ==');
{
  const s = freshGame(0);
  // 横一列 [0,1,2] を自分の石像で埋める
  putStatue(s, 0, 0, { atk: 1, hp: 1 });
  putStatue(s, 0, 1, { atk: 1, hp: 1 });
  putStatue(s, 0, 2, { atk: 1, hp: 1 });
  eq(completedLines(s.players[0].board).length, 1, '完成ライン1本');
  eq(lineBonus(s.players[0].board, 1, 1), 1, 'マス1のボーナス+1');
  eq(effectiveAtk(s.players[0].board, 1), 2, '実効攻撃力 1+1=2');

  // 交点の二重ボーナス: 縦[0,3,6]も埋めるとマス0は2ライン
  putStatue(s, 0, 3, { atk: 1, hp: 1 });
  putStatue(s, 0, 6, { atk: 1, hp: 1 });
  eq(completedLines(s.players[0].board).length, 2, '完成ライン2本');
  eq(lineBonus(s.players[0].board, 0, 0), 2, 'マス0(交点)はボーナス+2');
  eq(effectiveAtk(s.players[0].board, 0), 3, 'マス0の実効攻撃力 1+2=3');
}

// ===========================================================================
console.log('== 一方通行＋貫通 ==');
{
  // 攻撃力5で残HP2を倒す → 5-2+1=4 がリーダーへ
  const s = freshGame(0);
  putStatue(s, 0, 4, { atk: 5, hp: 3, summonedTurn: 0 }); // 召喚酔いなし(過去ターン)
  putStatue(s, 1, 4, { atk: 9, hp: 2 });
  const before = s.players[1].hp;
  const r = applyAction(s, { type: 'ATTACK', from: 4 });
  ok(r.ok, '攻撃成功');
  eq(s.players[1].board[4], null, '敵は撃破された');
  eq(s.players[1].hp, before - 4, '貫通4ダメージ (5-2+1)');
  eq(s.players[0].board[4].hp, 3, '攻撃側は一方通行で無傷');
}
{
  // 攻撃力3で残HP3を倒す → 3-3+1=1
  const s = freshGame(0);
  putStatue(s, 0, 4, { atk: 3, hp: 3, summonedTurn: 0 });
  putStatue(s, 1, 4, { atk: 1, hp: 3 });
  const before = s.players[1].hp;
  applyAction(s, { type: 'ATTACK', from: 4 });
  eq(s.players[1].hp, before - 1, '貫通1ダメージ (3-3+1)');
}
{
  // 攻撃力2で残HP5 → 倒せない、貫通なし、敵HP-2
  const s = freshGame(0);
  putStatue(s, 0, 4, { atk: 2, hp: 2, summonedTurn: 0 });
  putStatue(s, 1, 4, { atk: 1, hp: 5 });
  const before = s.players[1].hp;
  applyAction(s, { type: 'ATTACK', from: 4 });
  eq(s.players[1].hp, before, 'リーダーへの貫通なし');
  eq(s.players[1].board[4].hp, 3, '敵HPは2減って3');
}

// ===========================================================================
console.log('== ライン込みの貫通 ==');
{
  // 横[0,1,2]完成でマス1が攻3になり、残HP1の敵を倒すと貫通 3-1+1=3
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 2, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 1, { atk: 2, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 2, { atk: 2, hp: 1, summonedTurn: 0 });
  putStatue(s, 1, 1, { atk: 1, hp: 1 });
  eq(effectiveAtk(s.players[0].board, 1), 3, 'ライン込み攻3');
  const before = s.players[1].hp;
  applyAction(s, { type: 'ATTACK', from: 1 });
  eq(s.players[1].hp, before - 3, '貫通3 (3-1+1)');
}

// ===========================================================================
console.log('== キーワードと召喚酔い ==');
// 意図しないライン完成を避けるため、各ケースを独立した小盤面で検証する。
{
  // 召喚酔い: 今ターン召喚のキーワードなし → 攻撃不可
  const s = freshGame(0); // turnNumber=1, active=0
  putStatue(s, 0, 4, { atk: 2, hp: 2, summonedTurn: 1 });
  putStatue(s, 1, 4, { atk: 1, hp: 1 });
  ok(!hasValidAttack(s, 0, 4), 'キーワードなしは召喚ターン攻撃不可');
}
{
  // スピード: 今ターン召喚でも同座標の敵は殴れる
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 2, hp: 2, keywords: ['speed'], summonedTurn: 1 });
  putStatue(s, 1, 0, { atk: 1, hp: 1 });
  ok(hasValidAttack(s, 0, 0), 'スピードは召喚ターンでも敵を攻撃可');
}
{
  // スピードは前が空ならリーダーへ行けない
  const s = freshGame(0);
  putStatue(s, 0, 4, { atk: 2, hp: 2, keywords: ['speed'], summonedTurn: 1 });
  ok(!hasValidAttack(s, 0, 4), 'スピードは空座標でリーダーへ行けない');
}
{
  // リーダーアタッカー: 空座標なら基礎攻撃力でリーダーへ
  const s = freshGame(0);
  putStatue(s, 0, 4, { atk: 2, hp: 2, keywords: ['leader'], summonedTurn: 1 });
  ok(hasValidAttack(s, 0, 4), 'リーダーアタッカーは空座標でリーダーへ攻撃可');
  const before = s.players[1].hp;
  applyAction(s, { type: 'ATTACK', from: 4 });
  eq(s.players[1].hp, before - 2, 'リーダー直撃2ダメージ');
}

// ===========================================================================
console.log('== ターン進行とマナ・ドロー ==');
{
  const s = freshGame(0);
  const deck0Before = s.players[0].deck.length; // 15
  applyAction(s, { type: 'END_TURN' }); // → 後攻ターン
  eq(s.active, 1, '後攻のターン');
  eq(s.turnNumber, 2, 'ターン2');
  eq(s.players[1].maxMana, 1, '後攻ターン1の最大マナ1');
  // 後攻はドローあり: 手札6→7、デッキ15→14
  eq(s.players[1].hand.length, 7, '後攻はドローして7枚');
  applyAction(s, { type: 'END_TURN' }); // → 先攻ターン2
  eq(s.players[0].maxMana, 2, '先攻ターン2の最大マナ2');
  eq(s.players[0].deck.length, deck0Before - 1, '先攻ターン2でドロー（デッキ-1）');
}

// ===========================================================================
console.log('== 勝敗 ==');
{
  const s = freshGame(0);
  s.players[1].hp = 2;
  putStatue(s, 0, 6, { atk: 5, hp: 2, keywords: ['leader'], summonedTurn: 0 });
  applyAction(s, { type: 'ATTACK', from: 6 });
  eq(s.phase, 'gameover', 'ゲーム終了');
  eq(s.winner, 0, '先攻の勝利');
  // 終了後はアクション拒否
  const r = applyAction(s, { type: 'END_TURN' });
  ok(!r.ok, 'ゲーム終了後はアクション不可');
}

// ===========================================================================
console.log('== 再配置 ==');
{
  const s = freshGame(0);
  // 手札に再配置を1枚仕込む
  s.players[0].hand = [{ instanceId: 5001, cardId: 'saihaichi' }];
  s.players[0].mana = 5;
  putStatue(s, 0, 0, { atk: 1, hp: 1, summonedTurn: 0 });
  const r = applyAction(s, { type: 'PLAY', instanceId: 5001, from: 0, to: 8 });
  ok(r.ok, '再配置成功');
  eq(s.players[0].board[0], null, '移動元は空に');
  ok(s.players[0].board[8] != null, '移動先に石像');
  eq(s.players[0].board[8].pos, 8, 'pos が更新される');
}

// ===========================================================================
console.log('== 席ごとの状態直列化（オンライン用の隠匿）==');
{
  const s = freshGame(0); // 先攻=0, 後攻=1（後攻は起動の石込みで手札6枚）
  const view0 = serializeFor(s, 0); // 席0の視点
  const view1 = serializeFor(s, 1); // 席1の視点

  // 自分の手札は中身が見える
  ok(view0.players[0].hand.every((c) => c && c.cardId), '自分(席0)の手札は cardId が見える');
  ok(view1.players[1].hand.every((c) => c && c.cardId), '自分(席1)の手札は cardId が見える');
  // 相手の手札は中身が伏せられる（null 埋め）が、枚数は一致する
  ok(view0.players[1].hand.every((c) => c === null), '相手(席1)の手札中身は隠れる');
  eq(view0.players[1].hand.length, 6, '相手手札の枚数は保持される');
  ok(view1.players[0].hand.every((c) => c === null), '相手(席0)の手札中身は隠れる');
  eq(view1.players[0].hand.length, 5, '相手手札の枚数は保持される');
  // 山札は両者とも中身が伏せられる（枚数のみ）
  ok(view0.players[0].deck.every((c) => c === null), '自分の山札中身も隠れる');
  eq(view0.players[0].deck.length, s.players[0].deck.length, '自分の山札枚数は保持');
  // seed / rng はクライアントへ渡さない
  ok(view0.seed === undefined, 'seed は送らない');
  ok(view0.rng === undefined, 'rng は送らない');
  // 盤面・HP・マナなど公開情報は保持
  eq(view0.active, s.active, 'active は保持');
  eq(view0.turnNumber, s.turnNumber, 'turnNumber は保持');
  eq(view0.players[0].hp, s.players[0].hp, 'hp は保持');
}

// ===========================================================================
console.log('');
console.log(`結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
