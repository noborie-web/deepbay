import { describe, it, expect } from 'vitest'
import { SnkrDunkScraper } from '../lib/scrapers/snkrdunk'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageHtml(items: any[]): string {
  const nextData = { props: { pageProps: { listings: items } } }
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeItem(id: number): any {
  return { id: `l${id}`, name: `item-${id}`, price: 1000 + id, imageUrls: [] }
}

describe('SnkrDunkScraper.scrape search pagination', () => {
  it('1ページの件数が少なくても(< 20)、次ページが空でなければ取得を続ける', async () => {
    // メルカリ検索で見つかった不具合と同様のケース: 1ページ目が10件(想定の
    // 20件未満)しか返らなくても、2ページ目にまだ結果が残っている場合は
    // 継続して取得すべき。「件数の少なさ」だけで最終ページと誤判定しない。
    const pages: Record<string, string> = {
      '1': pageHtml(Array.from({ length: 10 }, (_, i) => fakeItem(i))),
      '2': pageHtml(Array.from({ length: 15 }, (_, i) => fakeItem(100 + i))),
      '3': pageHtml([]),
    }
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const pageParam = new URL(urlStr).searchParams.get('page') ?? '1'
      return new Response(pages[pageParam] ?? pageHtml([]), { status: 200 })
    }

    try {
      const scraper = new SnkrDunkScraper()
      const results = await scraper.scrape('https://snkrdunk.com/apparel-free-used-items?keywords=Nike', { limit: 600 })
      expect(results.length).toBe(25)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('空の結果が返ったページで正しく終了する', async () => {
    const pages: Record<string, string> = {
      '1': pageHtml(Array.from({ length: 20 }, (_, i) => fakeItem(i))),
      '2': pageHtml([]),
    }
    const origFetch = globalThis.fetch
    let maxPageRequested = 0
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const pageParam = parseInt(new URL(urlStr).searchParams.get('page') ?? '1', 10)
      maxPageRequested = Math.max(maxPageRequested, pageParam)
      return new Response(pages[String(pageParam)] ?? pageHtml([]), { status: 200 })
    }

    try {
      const scraper = new SnkrDunkScraper()
      const results = await scraper.scrape('https://snkrdunk.com/apparel-free-used-items?keywords=Nike', { limit: 600 })
      expect(results.length).toBe(20)
      expect(maxPageRequested).toBe(2)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
