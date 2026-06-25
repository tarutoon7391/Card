// カード定義（コア最小セット）
// engine からも ai/ui からも参照される単一の真実のソース。

export const CARD_DB = {
  seihei: {
    id: 'seihei',
    name: '整列兵',
    cost: 1,
    type: 'statue',
    atk: 1,
    hp: 1,
    keywords: [],
    text: 'なし（ライン要員）',
  },
  totsugeki: {
    id: 'totsugeki',
    name: '突撃兵',
    cost: 2,
    type: 'statue',
    atk: 2,
    hp: 2,
    keywords: ['speed'],
    text: 'スピードアタッカー',
  },
  denrei: {
    id: 'denrei',
    name: '疾走の伝令',
    cost: 3,
    type: 'statue',
    atk: 2,
    hp: 2,
    keywords: ['leader'],
    text: 'リーダーアタッカー',
  },
  lineload: {
    id: 'lineload',
    name: '終撃のラインロード',
    cost: 4,
    type: 'statue',
    atk: 3,
    hp: 3,
    keywords: [],
    text: 'なし（重量級。ライン上で化ける）',
  },
  saihaichi: {
    id: 'saihaichi',
    name: '再配置',
    cost: 1,
    type: 'spell',
    spell: 'reposition',
    text: '自分の石像1体を任意の空きマスへ移動',
  },
  kido: {
    id: 'kido',
    name: '起動の石',
    cost: 0,
    type: 'spell',
    spell: 'mana',
    text: 'このターンのマナ +1（使い切り・後攻のみ初期手札）',
  },
};

// デッキ（ミラー戦）: 各4枚 = 20枚。起動の石はデッキに含めない（後攻の初期手札に1枚だけ）。
export const DECK_LIST = ['seihei', 'totsugeki', 'denrei', 'lineload', 'saihaichi'];
export const COPIES_PER_CARD = 4;

// キーワード判定ヘルパ
export function hasKeyword(card, kw) {
  return Array.isArray(card.keywords) && card.keywords.includes(kw);
}
