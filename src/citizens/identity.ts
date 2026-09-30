export const stableHash = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) / 4294967296;
};
const surnames = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '清水', '斎藤', '池田', '橋本', '阿部', '石川', '森', '前田', '藤田', '岡田', '長谷川', '村上', '近藤', '石井'];
const names = ['葵', '陽菜', '蓮', '湊', '凛', '結衣', '悠真', '陽太', '美月', '颯太', '咲良', '大翔', '杏', '悠人', '紬', '蒼', '彩花', '健太', '遥', '直樹', '真央', '拓海', '千尋', '優斗', '美咲', '翼', '七海', '春樹', '和希', '沙織', '浩平', '明日香'];
export const citizenName = (householdId: string, id: string): string =>
  `${surnames[Math.floor(stableHash(householdId) * surnames.length)]} ${names[Math.floor(stableHash(`${id}:name`) * names.length)]}`;

export const buildingLabel = (id: string, zone: 'residential' | 'commercial' | 'office' | 'industrial'): string =>
  `${{ residential: '住宅', commercial: '店舗', office: 'オフィス', industrial: '工場' }[zone]} ${1000 + Math.floor(stableHash(id) * 9000)}`;
