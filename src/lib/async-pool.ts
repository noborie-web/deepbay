// 本番で確認した不具合(2026-10-03): メルカリの抽出が90%(ページ取得完了)の
// あとAI処理中に実行時間の上限(300秒)で強制終了され、商品が0件になった。
//
// 原因のひとつは、AI呼び出しを「N件ずつのチャンク + Promise.all」で直列に
// 回していたこと。チャンク方式はチャンク内で最も遅い1件が終わるまで次の
// チャンクに進めないため、1件あたり平均1秒でも遅い1件が3秒かかると
// チャンクごとに3秒かかる(=実効並列度が大きく下がる)。
//
// ワーカープール方式にすると、空いたワーカーが即座に次の要素を取るため、
// 遅い要素が全体を止めない。
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  const results = new Array<R>(items.length)
  let next = 0

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return results
}
