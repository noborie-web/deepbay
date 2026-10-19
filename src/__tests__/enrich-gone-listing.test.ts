import { describe, expect, it } from 'vitest'
import { ScraperError } from '@/lib/scrapers/types'

// ユーザー報告(2026-10-19): 補完に時間がかかりすぎる。
// 調べたところ、残っていた18件はすべて404(終了した出品)で、
// 成功しようがないのに5回・最大2.5時間かけて再試行していた。

describe('ScraperError の状態コード', () => {
  it('404を見分けられる（再試行しても無駄なものを区別するため）', () => {
    const error = new ScraperError('HTTP 404: Not Found', 'yahoo_auction', 'https://example.com/x', 404)
    expect(error.status).toBe(404)
  })

  it('状態コードが無い従来の使い方も壊さない', () => {
    const error = new ScraperError('timeout', 'yahoo_auction', 'https://example.com/x')
    expect(error.status).toBeUndefined()
    expect(error.siteKey).toBe('yahoo_auction')
  })

  // 404以外(混雑・タイムアウト等)は時間を置けば成功しうるので、再試行を残す
  it('500は404と区別される', () => {
    const error = new ScraperError('HTTP 500', 'yahoo_auction', 'https://example.com/x', 500)
    expect(error.status).not.toBe(404)
  })
})
