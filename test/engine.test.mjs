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
  // 先攻ターン1はドローなし → デッキ64-5=59（全16種×4枚）
  eq(s.players[0].deck.length, 59, '先攻はターン1ドローなしでデッキ59');
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
// 拡張カードの効果
// ===========================================================================
function giveHand(state, seat, cardId, mana = 10) {
  const iid = 7000 + Math.floor(mana * 13);
  state.players[seat].hand = [{ instanceId: iid, cardId }];
  state.players[seat].mana = mana;
  return iid;
}

console.log('== 整列兵：ライン完成で1ドロー ==');
{
  const s = freshGame(0);
  // 横[0,1,2] のうち [0,1] を整列兵で埋め、3枚目を手札から置いて完成させる
  putStatue(s, 0, 0, { atk: 1, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 1, { atk: 1, hp: 1, summonedTurn: 0 });
  s.players[0].board[0].cardId = 'seihei';
  s.players[0].board[1].cardId = 'seihei';
  const iid = giveHand(s, 0, 'seihei'); // 手札をこの1枚だけにリセット
  const r = applyAction(s, { type: 'PLAY', instanceId: iid, index: 2 });
  ok(r.ok, '整列兵を置けた');
  eq(completedLines(s.players[0].board).length, 1, 'ライン完成');
  // 置いた整列兵＋既存2体、計3体の整列兵がライン完成で各1ドロー。
  // 手札は1枚を消費して空 → 3ドローで3枚。
  eq(s.players[0].hand.length, 3, '整列兵3体ぶん各1ドロー');
}

console.log('== 終撃のラインロード：バーン ==');
{
  const s = freshGame(0);
  // 先に横ラインを1本完成させてから（このターン内）ラインロードを出す
  putStatue(s, 0, 0, { atk: 1, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 1, { atk: 1, hp: 1, summonedTurn: 0 });
  const iid1 = giveHand(s, 0, 'seihei');
  applyAction(s, { type: 'PLAY', instanceId: iid1, index: 2 }); // ライン完成（1本）
  eq(s.players[0].linesCompletedThisTurn, 1, '今ターン完成1本');
  const before = s.players[1].hp;
  const iid2 = giveHand(s, 0, 'lineload');
  applyAction(s, { type: 'PLAY', instanceId: iid2, index: 4 });
  eq(s.players[1].hp, before - 2, 'ラインロードで 1×2 = 2 バーン');
}

console.log('== 終撃のラインロード：自身の召喚で完成したラインも数える ==');
{
  const s = freshGame(0);
  // 右列[2,5,8] のうち [2,5] を埋め、3枚目をラインロード自身の召喚で完成させる
  putStatue(s, 0, 2, { atk: 1, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 5, { atk: 1, hp: 1, summonedTurn: 0 });
  const before = s.players[1].hp;
  const iid = giveHand(s, 0, 'lineload');
  const r = applyAction(s, { type: 'PLAY', instanceId: iid, index: 8 }); // [2,5,8]完成
  ok(r.ok, 'ラインロードを置けた');
  eq(completedLines(s.players[0].board).length, 1, '自身でライン完成');
  eq(s.players[1].hp, before - 2, '自身の完成ライン1本×2 = 2バーン');
}

console.log('== 増殖兵：右隣にコピー ==');
{
  const s = freshGame(0);
  const iid = giveHand(s, 0, 'zoshoku');
  applyAction(s, { type: 'PLAY', instanceId: iid, index: 0 });
  ok(s.players[0].board[0] != null, '本体が0に');
  ok(s.players[0].board[1] != null, '右隣1にコピー');
  eq(s.players[0].board[1].cardId, 'token', 'コピーはトークン');
}

console.log('== 双子の歩兵：2体召喚 ==');
{
  const s = freshGame(0);
  const iid = giveHand(s, 0, 'futago');
  const r = applyAction(s, { type: 'PLAY', instanceId: iid, cells: [0, 8] });
  ok(r.ok, '双子成功');
  ok(s.players[0].board[0] && s.players[0].board[8], '2マスに石兵');
  // 同じマス2つはエラー
  const s2 = freshGame(0);
  const iid2 = giveHand(s2, 0, 'futago');
  ok(!applyAction(s2, { type: 'PLAY', instanceId: iid2, cells: [0, 0] }).ok, '同じマスは不正');
}

console.log('== 突き飛ばし：敵を隣へ ==');
{
  const s = freshGame(0);
  putStatue(s, 1, 4, { atk: 2, hp: 2 });
  const iid = giveHand(s, 0, 'tsukitobashi');
  const r = applyAction(s, { type: 'PLAY', instanceId: iid, target: 4, to: 1 });
  ok(r.ok, '突き飛ばし成功');
  eq(s.players[1].board[4], null, '元位置は空');
  ok(s.players[1].board[1] != null, '隣へ移動');
  // 非隣接はエラー
  const s2 = freshGame(0);
  putStatue(s2, 1, 4, { atk: 2, hp: 2 });
  const iid2 = giveHand(s2, 0, 'tsukitobashi');
  ok(!applyAction(s2, { type: 'PLAY', instanceId: iid2, target: 4, to: 0 }).ok, '非隣接は不正');
}

console.log('== 鉤縄の番兵：正面へ引き寄せ ==');
{
  const s = freshGame(0);
  putStatue(s, 1, 0, { atk: 3, hp: 2 }); // 敵が左上に
  const iid = giveHand(s, 0, 'kaginawa');
  // 正面(同座標0)が空なら、敵を0へ引き寄せ
  const r = applyAction(s, { type: 'PLAY', instanceId: iid, index: 0, pull: 0 });
  // 番兵を0に置く → 正面(敵盤の0)に既に敵がいるので引き寄せ不可。別マスで検証し直す
  ok(r.ok, '番兵召喚');
}
{
  const s = freshGame(0);
  putStatue(s, 1, 0, { atk: 3, hp: 2 }); // 敵が左上(0)に
  const iid = giveHand(s, 0, 'kaginawa');
  applyAction(s, { type: 'PLAY', instanceId: iid, index: 4 }); // 番兵を中央(4)に
  // 正面(敵盤の4)は空 → 敵0を4へ引き寄せ（自動で最強を選ぶ）
  eq(s.players[1].board[0], null, '敵の元位置は空');
  ok(s.players[1].board[4] != null, '敵が正面4へ');
}

console.log('== 目覚めの号令：召喚酔い解除 ==');
{
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 2, hp: 2, summonedTurn: 1 }); // 今ターン召喚＝酔い
  putStatue(s, 1, 0, { atk: 1, hp: 1 });
  ok(!hasValidAttack(s, 0, 0), '解除前は攻撃不可');
  const iid = giveHand(s, 0, 'mezame');
  applyAction(s, { type: 'PLAY', instanceId: iid, target: 0 });
  ok(hasValidAttack(s, 0, 0), '解除後は攻撃可');
}

console.log('== 再起の鼓動：再攻撃 ==');
{
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 2, hp: 2, summonedTurn: 0 });
  putStatue(s, 1, 0, { atk: 1, hp: 5 });
  applyAction(s, { type: 'ATTACK', from: 0 });
  ok(!hasValidAttack(s, 0, 0), '一度攻撃したら不可');
  const iid = giveHand(s, 0, 'saiki');
  applyAction(s, { type: 'PLAY', instanceId: iid, target: 0 });
  ok(hasValidAttack(s, 0, 0), '再起で再攻撃可');
}

console.log('== 守護の石壁：致死を1回耐える ==');
{
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 9, hp: 2, summonedTurn: 0 });
  putStatue(s, 1, 0, { atk: 1, hp: 2 });
  s.players[1].board[0].shield = true; // 相手がシールド持ち
  const before = s.players[1].hp;
  applyAction(s, { type: 'ATTACK', from: 0 });
  ok(s.players[1].board[0] != null, 'シールドで生存');
  eq(s.players[1].board[0].hp, 1, 'HP1で残る');
  eq(s.players[1].hp, before, '撃破されないので貫通なし');
  ok(!s.players[1].board[0].shield, 'シールドは消費');
}

console.log('== 返しの石像：反撃 ==');
{
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 2, hp: 2, summonedTurn: 0 });
  putStatue(s, 1, 0, { atk: 1, hp: 3, keywords: ['counter'] }); // 返しの石像役
  applyAction(s, { type: 'ATTACK', from: 0 }); // 倒せない(2<3) → 反撃される
  ok(s.players[1].board[0] != null, '返しの石像は生存');
  eq(s.players[0].board[0].hp, 1, '反撃1で攻撃側HP2→1');
}
{
  // 撃破された場合は反撃しない
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 5, hp: 2, summonedTurn: 0 });
  putStatue(s, 1, 0, { atk: 3, hp: 3, keywords: ['counter'] });
  applyAction(s, { type: 'ATTACK', from: 0 });
  eq(s.players[1].board[0], null, '返しの石像は撃破');
  eq(s.players[0].board[0].hp, 2, '撃破時は反撃なし（HP無傷）');
}

console.log('== 風化：攻撃力-2 ==');
{
  const s = freshGame(0);
  putStatue(s, 1, 4, { atk: 3, hp: 3 });
  const iid = giveHand(s, 0, 'fuka');
  applyAction(s, { type: 'PLAY', instanceId: iid, target: 4 });
  eq(s.players[1].board[4].atk, 1, '3-2=1');
  // 0未満にはしない
  const s2 = freshGame(0);
  putStatue(s2, 1, 4, { atk: 1, hp: 3 });
  const iid2 = giveHand(s2, 0, 'fuka');
  applyAction(s2, { type: 'PLAY', instanceId: iid2, target: 4 });
  eq(s2.players[1].board[4].atk, 0, '0未満にしない');
}

console.log('== 崩落：破壊（貫通なし） ==');
{
  const s = freshGame(0);
  putStatue(s, 1, 4, { atk: 5, hp: 5 });
  const before = s.players[1].hp;
  const iid = giveHand(s, 0, 'horaku');
  applyAction(s, { type: 'PLAY', instanceId: iid, target: 4 });
  eq(s.players[1].board[4], null, '破壊された');
  eq(s.players[1].hp, before, '崩落では貫通ダメージなし');
  // シールドは破壊を1回耐える
  const s2 = freshGame(0);
  putStatue(s2, 1, 4, { atk: 5, hp: 5 });
  s2.players[1].board[4].shield = true;
  const iid2 = giveHand(s2, 0, 'horaku');
  applyAction(s2, { type: 'PLAY', instanceId: iid2, target: 4 });
  ok(s2.players[1].board[4] != null, '守護で破壊を耐える');
}

console.log('== 連鎖の旗兵：ライン完成で石兵召喚（1ターン1回） ==');
{
  const s = freshGame(0);
  putStatue(s, 0, 0, { atk: 1, hp: 1, summonedTurn: 0 });
  putStatue(s, 0, 1, { atk: 1, hp: 1, summonedTurn: 0 });
  s.players[0].board[0].cardId = 'kihei';
  const occupiedBefore = s.players[0].board.filter((x) => x).length;
  const iid = giveHand(s, 0, 'seihei');
  applyAction(s, { type: 'PLAY', instanceId: iid, index: 2 }); // 横[0,1,2]完成
  eq(completedLines(s.players[0].board).length >= 1, true, 'ライン完成');
  // 旗兵が石兵を1体追加 → 置いた整列兵(+1)＋トークン(+1) = +2
  eq(s.players[0].board.filter((x) => x).length, occupiedBefore + 2, '旗兵が石兵を1体追加');
}

// ===========================================================================
console.log('');
console.log(`結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
