import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

describe('未検証のまま取り下げられた出品の復旧', () => {
  const supplierCheck = readFileSync('src/lib/inventory-supplier-check.ts', 'utf8')
  const quickCheck = readFileSync('src/lib/inventory-quick-check.ts', 'utf8')

  // 本番で起きた事故(2026-10-23): eBayレポート取り込みで quantity=0 になった
  // 656件が、仕入先を確認しないまま取り下げられた。抜き取り20件のうち13件
  // (65%)はその時点でも即決価格で購入できた。
  it('一度も確認していない出品は在庫0でも仕入先チェックの対象にする', () => {
    expect(supplierCheck).toContain("'quantity.gt.0,quantity.is.null,supplier_checked_at.is.null'")
  })

  it('取り下げ済みかどうかを見分ける列を取得している', () => {
    expect(supplierCheck).toContain('delisted_at, seller_account_id, site_id')
  })

  it('確認できて購入可能なら在庫1に戻し、取り下げを解除する', () => {
    expect(supplierCheck).toContain('update.quantity = 1')
    expect(supplierCheck).toContain('update.delisted_at = null')
    expect(supplierCheck).toContain('result.restored_item_ids.push')
  })

  it('戻す条件は「購入可能」かつ「取り下げ済み」かつ「未検証」の3つすべて', () => {
    // どれか1つでも欠けると、正当に取り下げた出品まで戻してしまう
    expect(supplierCheck).toContain("outcome === 'available'")
    expect(supplierCheck).toContain('listing.delisted_at != null')
    expect(supplierCheck).toContain('listing.supplier_checked_at == null')
  })

  it('eBay側の在庫も1に戻し、履歴に残す', () => {
    expect(quickCheck).toContain('markListingsRestored')
    expect(quickCheck).toContain('unverified_delist_recovered')
    // ItemIDを100件超まとめて .in() に渡すとURLが長すぎて400になる
    expect(quickCheck).toContain('selectInChunks')
  })
})
