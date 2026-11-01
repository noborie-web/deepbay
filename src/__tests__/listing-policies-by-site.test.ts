import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePoliciesBySite, policiesForSite } from '@/lib/listing-policies'

// ユーザー報告(2026-10-19): ビジネスポリシーはマーケットプレイスごとに別物
// なので、1つの名前を全サイトのCSVに書くと、そのサイトに存在しないポリシー名が
// 入ってしまう。
//
// ユーザー報告(2026-11-01): そのときの修正を出品CSV(/api/csv)にだけ入れ、
// Specifics-IN CSV(/api/csv/specifics)に入れ忘れていた。UK/AUの2ファイルを
// 出すと、UKのCSVにAUの配送ポリシー(3area excluded ver.)が入り、eBayに
// アップロードしても「ポリシーが適用されない」となっていた。

const FALLBACK = { payment: 'US Pay', return: 'US Return', shipping: 'US Ship' }

describe('サイトごとのビジネスポリシー', () => {
  it('サイト別の指定を読む', () => {
    const parsed = parsePoliciesBySite(JSON.stringify({
      UK: { payment: 'eBay Payments', return: 'UK Return', shipping: 'USED 3area excluded ver.' },
      AU: { payment: 'eBay Payments', return: 'AU Return', shipping: '3area excluded ver.' },
    }))
    expect(parsed.UK.shipping).toBe('USED 3area excluded ver.')
    expect(parsed.AU.shipping).toBe('3area excluded ver.')
  })

  it('3つ揃っていない指定は使わない(中途半端な名前を書かない)', () => {
    const parsed = parsePoliciesBySite(JSON.stringify({ UK: { payment: 'eBay Payments' } }))
    expect(parsed.UK).toBeUndefined()
  })

  it('読めない値は無視して単一指定に落とす', () => {
    expect(parsePoliciesBySite('壊れたJSON')).toEqual({})
    expect(parsePoliciesBySite(null)).toEqual({})
  })

  it('サイトの指定があればそれを、無ければ単一指定を使う', () => {
    const bySite = parsePoliciesBySite(JSON.stringify({
      UK: { payment: 'eBay Payments', return: 'UK Return', shipping: 'USED 3area excluded ver.' },
    }))
    expect(policiesForSite(bySite, 'UK', FALLBACK).shipping).toBe('USED 3area excluded ver.')
    // ここが本題。AUの指定が無いときにUKの値を使ってはいけない
    expect(policiesForSite(bySite, 'AU', FALLBACK)).toEqual(FALLBACK)
  })
})

// 2つのCSV出力で同じ取り残しが再発しないようにする。
// 2026-10-19 に出品CSVだけ直し、Specifics-IN が2週間気づかれないまま残った。
describe('CSVを出す経路', () => {
  const routes = [
    'src/app/api/csv/route.ts',
    'src/app/api/csv/specifics/route.ts',
  ]

  it.each(routes)('%s はサイトごとのポリシーを使う', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    expect(source).toContain('parsePoliciesBySite')
    expect(source).toContain('policiesForSite')
    // 単一指定をそのまま渡していないこと
    expect(source).not.toContain('paymentProfileName: paymentProfile')
    expect(source).not.toContain('shippingProfileName: shippingProfile')
  })
})
