// ユーザー要望(2026-10-20): 価格改定をプレビュー全件ではなく、確認した分だけ
// 実行したい。対象が2,000件規模になることがあり、まとめて反映すると
// 仕入値が動いていない商品まで値上げしてしまう。
//
// 実データでの内訳(2026-10-20): 値上げ対象1,782件のうち、仕入値が実際に
// 上がっていたのは44件だけだった。

/** 貼り付けたアイテムIDのうち、プレビューに含まれるものだけを選ぶ */
export function selectByPastedIds(
  availableIds: string[],
  pasted: string,
): Set<string> {
  const wanted = new Set(
    pasted.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
  )
  // 何も貼られていなければ全件(絞り込み解除)
  if (wanted.size === 0) return new Set(availableIds)
  return new Set(availableIds.filter((id) => wanted.has(id)))
}

/** 実行時にサーバーへ送るID。プレビューの並び順を保つ */
export function itemIdsToRun(availableIds: string[], selected: Set<string>): string[] {
  return availableIds.filter((id) => selected.has(id))
}
