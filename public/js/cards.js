// カード定義（全16種 ＋ 起動の石・トークン）
// engine からも ai/ui からも参照される単一の真実のソース。
//
// メタ情報の意味:
//   keywords  : 'speed'(スピードアタッカー) / 'leader'(リーダーアタッカー) / 'counter'(反撃)
//   trigger   : ライン完成時に発火する効果   'draw'(1ドロー) / 'spawn'(石兵を召喚, 1ターン1回)
//   summon    : 召喚時に発火する効果         'move'/'burn'/'copyRight'/'pull'
//   targeting : 呪文の対象選択の種類（ui.js が入力フローを切り替える）
//                 'none'         … 対象なし（即時）
//                 'move-friendly'… 自分の石像1体 → 空きマス（from/to）
//                 'two-empty'    … 別々の空きマス2つ（cells:[a,b]）
//                 'push-enemy'   … 敵石像1体 → 隣接する空きマス（target/to）
//                 'friendly'     … 自分の石像1体（target）
//                 'enemy'        … 敵石像1体（target）

export const CARD_DB = {
  // === コア（5種） ===
  seihei: {
    id: 'seihei',
    name: '整列兵',
    cost: 1,
    type: 'statue',
    atk: 1,
    hp: 1,
    keywords: [],
    trigger: 'draw',
    text: 'ライン完成時に1ドロー',
  },
  totsugeki: {
    id: 'totsugeki',
    name: '突撃兵',
    cost: 2,
    type: 'statue',
    atk: 2,
    hp: 1,
    keywords: ['speed'],
    text: 'スピードアタッカー',
  },
  denrei: {
    id: 'denrei',
    name: '疾走の伝令',
    cost: 3,
    type: 'statue',
    atk: 1,
    hp: 2,
    keywords: ['leader'],
    summon: 'move',
    text: 'リーダーアタッカー。召喚時、味方1体を隣の空きへ移動（任意）',
  },
  lineload: {
    id: 'lineload',
    name: '終撃のラインロード',
    cost: 4,
    type: 'statue',
    atk: 3,
    hp: 3,
    keywords: [],
    summon: 'burn',
    text: '召喚時、今ターン完成させたライン本数×2点を相手リーダーへ',
  },
  saihaichi: {
    id: 'saihaichi',
    name: '再配置',
    cost: 1,
    type: 'spell',
    spell: 'reposition',
    targeting: 'move-friendly',
    text: '自分の石像1体を任意の空きマスへ移動',
  },

  // === 展開（3種） ===
  futago: {
    id: 'futago',
    name: '双子の歩兵',
    cost: 3,
    type: 'spell',
    spell: 'twins',
    targeting: 'two-empty',
    text: '1/1の石兵を2体、別々の空きマスに召喚',
  },
  zoshoku: {
    id: 'zoshoku',
    name: '増殖兵',
    cost: 2,
    type: 'statue',
    atk: 1,
    hp: 1,
    keywords: [],
    summon: 'copyRight',
    text: '召喚時、右隣のマスが空なら1/1コピーを置く',
  },
  kihei: {
    id: 'kihei',
    name: '連鎖の旗兵',
    cost: 3,
    type: 'statue',
    atk: 2,
    hp: 2,
    keywords: [],
    trigger: 'spawn',
    text: '自分を含むライン完成時、1/1を召喚（1ターン1回）',
  },

  // === トリッキー：敵を動かす（2種） ===
  tsukitobashi: {
    id: 'tsukitobashi',
    name: '突き飛ばし',
    cost: 1,
    type: 'spell',
    spell: 'push',
    targeting: 'push-enemy',
    text: '敵石像1体を隣接する空きマスへ押す',
  },
  kaginawa: {
    id: 'kaginawa',
    name: '鉤縄の番兵',
    cost: 2,
    type: 'statue',
    atk: 2,
    hp: 2,
    keywords: [],
    summon: 'pull',
    text: '召喚時、敵石像1体を正面（同座標）へ引き寄せる ※正面が空きのとき',
  },

  // === トリッキー：酔い解除・再攻撃（2種） ===
  mezame: {
    id: 'mezame',
    name: '目覚めの号令',
    cost: 2,
    type: 'spell',
    spell: 'wake',
    targeting: 'friendly',
    text: '味方石像1体の召喚酔いを解除',
  },
  saiki: {
    id: 'saiki',
    name: '再起の鼓動',
    cost: 2,
    type: 'spell',
    spell: 'reattack',
    targeting: 'friendly',
    text: '味方石像1体は、このターンもう一度攻撃できる',
  },

  // === トリッキー：守り・カウンター（2種） ===
  ishikabe: {
    id: 'ishikabe',
    name: '守護の石壁',
    cost: 1,
    type: 'spell',
    spell: 'shield',
    targeting: 'friendly',
    text: '味方石像1体、1回だけ破壊を耐える',
  },
  kaeshi: {
    id: 'kaeshi',
    name: '返しの石像',
    cost: 2,
    type: 'statue',
    atk: 1,
    hp: 3,
    keywords: ['counter'],
    text: '攻撃されたとき、殴ってきた敵に攻撃力ぶん反撃',
  },

  // === トリッキー：確定除去・弱体（2種） ===
  fuka: {
    id: 'fuka',
    name: '風化',
    cost: 2,
    type: 'spell',
    spell: 'weaken',
    targeting: 'enemy',
    text: '敵石像1体の攻撃力を-2（永続。0未満にはしない）',
  },
  horaku: {
    id: 'horaku',
    name: '崩落',
    cost: 4,
    type: 'spell',
    spell: 'destroy',
    targeting: 'enemy',
    text: '敵石像1体を破壊（貫通ダメージは起きない）',
  },

  // === 特殊・トークン（デッキには入らない） ===
  kido: {
    id: 'kido',
    name: '起動の石',
    cost: 0,
    type: 'spell',
    spell: 'mana',
    targeting: 'none',
    text: 'このターンのマナ +1（使い切り・後攻のみ初期手札）',
  },
  token: {
    id: 'token',
    name: '石兵',
    cost: 0,
    type: 'statue',
    atk: 1,
    hp: 1,
    keywords: [],
    text: 'トークン（1/1）',
  },
};

// デッキ（ミラー戦）: 全16種を各4枚 = 64枚。
// 起動の石（後攻の初期手札に1枚）とトークンはデッキに含めない。
export const DECK_LIST = [
  // コア
  'seihei', 'totsugeki', 'denrei', 'lineload', 'saihaichi',
  // 展開
  'futago', 'zoshoku', 'kihei',
  // トリッキー
  'tsukitobashi', 'kaginawa', 'mezame', 'saiki',
  'ishikabe', 'kaeshi', 'fuka', 'horaku',
];
export const COPIES_PER_CARD = 4;

// キーワード判定ヘルパ
export function hasKeyword(card, kw) {
  return Array.isArray(card.keywords) && card.keywords.includes(kw);
}
