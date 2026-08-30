'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Trash2, Link, ChevronUp, ChevronDown } from 'lucide-react'
import type { Product } from '@/types/database'
import TitleEditModal, { applyOp } from './TitleEditModal'
import type { TitleEditOp, TitleEditScope } from './TitleEditModal'
import PriceEditModal from './PriceEditModal'
import ConditionEditModal from './ConditionEditModal'
import BrandEditModal from './BrandEditModal'
import type { BrandEditScope } from './BrandEditModal'
import DescriptionEditModal, { applyDescriptionOp, DESCRIPTION_MAX_LENGTH } from './DescriptionEditModal'
import type { DescriptionEditOp, DescriptionEditScope } from './DescriptionEditModal'
import ImageCountEditModal, { limitImages } from './ImageCountEditModal'
import type { ImageCountEditScope } from './ImageCountEditModal'
import ItemSpecificsEditModal, { mergeItemSpecifics } from './ItemSpecificsEditModal'
import type {
  ItemSpecifics,
  ItemSpecificsEditMode,
  ItemSpecificsEditScope,
} from './ItemSpecificsEditModal'
import {
  findDangerSellerProductIds,
  findKeywordProductIds,
  findLowRatingProductIds,
  findPriceRangeProductIds,
  findPriceTypeProductIds,
  findSlowShippingProductIds,
  findStaleProductIds,
  findVeroProductIds,
  getProductPriceType,
} from '@/lib/product-exclusion'
import type { KeywordMatchField, ProductPriceType } from '@/lib/product-exclusion'
import {
  DEFAULT_PRODUCT_SEARCH_FILTERS,
  filterProducts,
} from '@/lib/product-search'
import type { ProductSearchFilters } from '@/lib/product-search'
import PokemonEditPanel from './PokemonEditPanel'
import type { PokemonEditScope } from './PokemonEditPanel'
import { isPokemonProduct } from '@/lib/pokemon'

interface Props {
  extractionId: string
  onClose: () => void
}

type Tab = 'main' | 'exclude' | 'edit' | 'search' | 'pokemon'
type ImageSize = '小' | '中' | '大'
type EditMode = '簡易編集モード' | '詳細編集モード'

const IMAGE_SIZE_MAP: Record<ImageSize, string> = {
  小: 'w-20 h-20',
  中: 'w-32 h-32',
  大: 'w-48 h-48',
}

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200]

export default function ProductEditPanel({ extractionId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('main')
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState<ImageSize>('小')
  const [bulkSize, setBulkSize] = useState('50')
  const [editMode, setEditMode] = useState<EditMode>('簡易編集モード')
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)
  const [searchFilters, setSearchFilters] = useState<ProductSearchFilters>(
    DEFAULT_PRODUCT_SEARCH_FILTERS,
  )
  const [collapsed, setCollapsed] = useState(false)
  const [autoScroll, setAutoScroll] = useState(false)
  const [scrollSpeed, setScrollSpeed] = useState(4)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // local edits buffer
  const [edits, setEdits] = useState<Record<string, Partial<Product & { purchase_price_jpy: number | null }>>>({})

  // 除外タブ
  const [excludeRunning, setExcludeRunning] = useState<Record<string, boolean>>({})
  const [excludeMsg, setExcludeMsg] = useState('')
  const [excludePanel, setExcludePanel] = useState<string | null>(null)
  // 除外済みフラグ: 公式ツールに合わせ、除外を一度実行した項目にチェックマークを表示する。
  const [excludeDone, setExcludeDone] = useState<Record<string, boolean>>({})
  // 除外予定ID: 除外を実行した時点では一覧から消すだけで、実際のDELETE APIは
  // 呼ばない(ユーザー要望: メインタブの「編集保存」を押すまで確定させない)。
  // 保存前にパネルを閉じれば除外は取り消される。他の項目の編集(edits)と
  // 同様に、saveAll()実行時にまとめて反映する。
  const [pendingExcludeIds, setPendingExcludeIds] = useState<Set<string>>(new Set())
  // 出品済み商品を強制削除する確認を得た除外予定ID(保存時にforce=trueを付与する)。
  const [forcedExcludeIds, setForcedExcludeIds] = useState<Set<string>>(new Set())

  // Vero・危険セラー・危険単語は抽出設定(サーバー側)に依存するため、
  // 実行前の件数プレビューを表示するには先に設定を取得しておく必要がある。
  // パネルを開くたびに再取得するのではなく1回だけ取得してキャッシュする。
  const [dangerSettings, setDangerSettings] = useState<{
    veroBrands: string[]
    sellerUrls: string[]
    words: string[]
  } | null>(null)
  const dangerSettingsFetchedRef = useRef(false)

  // 危険単語: 判定対象項目(タイトル/ブランド/商品詳細)を個別に選択できる。
  // 公式ツールに合わせデフォルトは全て有効。
  const [wordCheckTitle, setWordCheckTitle] = useState(true)
  const [wordCheckBrand, setWordCheckBrand] = useState(true)
  const [wordCheckDescription, setWordCheckDescription] = useState(true)

  // スポット文字: 危険単語と同様、判定対象項目(タイトル/ブランド/商品詳細)を
  // 個別に選択できる。公式ツールに合わせデフォルトは全て有効。
  const SPOT_PRESETS = ['難あり', 'ジャンク', '破損', '動作未確認', '訳あり', '傷あり', 'シミ', '汚れ', 'カビ', '臭い', 'NG']
  const [spotSelected, setSpotSelected] = useState<Set<string>>(new Set())
  const [spotCustom, setSpotCustom] = useState('')
  const [spotCheckTitle, setSpotCheckTitle] = useState(true)
  const [spotCheckBrand, setSpotCheckBrand] = useState(true)
  const [spotCheckDescription, setSpotCheckDescription] = useState(true)

  // 価格範囲
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [priceTarget, setPriceTarget] = useState<'original' | 'ebay'>('original')

  // 簡易除外
  const [quickKeywords, setQuickKeywords] = useState('')

  // 評価数フィルタ: セラーの総合評価数がこの件数未満なら除外(下限)
  const [ratingMin, setRatingMin] = useState('')

  // 発送日数フィルタ
  const [shippingDaysMax, setShippingDaysMax] = useState('')

  // 最終更新月フィルタ
  const [updatedMonthsAgo, setUpdatedMonthsAgo] = useState('3')

  // Vero・価格タイプ
  const [priceTypesSelected, setPriceTypesSelected] = useState<Record<ProductPriceType, boolean>>({
    fixed: false,
    auction: true,
  })

  // 編集モーダル
  const [titleModalOpen, setTitleModalOpen] = useState(false)
  const [brandModalOpen, setBrandModalOpen] = useState(false)
  const [descriptionModalOpen, setDescriptionModalOpen] = useState(false)
  const [imageCountModalOpen, setImageCountModalOpen] = useState(false)
  const [itemSpecificsModalOpen, setItemSpecificsModalOpen] = useState(false)
  const [priceModalOpen, setPriceModalOpen] = useState(false)
  const [conditionModalOpen, setConditionModalOpen] = useState(false)

  function updateSearchFilter<K extends keyof ProductSearchFilters>(
    key: K,
    value: ProductSearchFilters[K],
  ) {
    setSearchFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }

  function resetSearchFilters() {
    setSearchFilters(DEFAULT_PRODUCT_SEARCH_FILTERS)
    setPage(1)
  }

  function togglePanel(key: string) {
    setExcludePanel((v) => v === key ? null : key)
    setExcludeMsg('')
  }

  async function runExclude(key: string, fn: () => Promise<string[]>) {
    setExcludeRunning((v) => ({ ...v, [key]: true }))
    setExcludeMsg('')
    try {
      const removedIds = await fn()
      setExcludeDone((v) => ({ ...v, [key]: true }))
      if (removedIds.length > 0) {
        setProducts((prev) => prev.filter((p) => !removedIds.includes(p.id)))
        setExcludeMsg(`${removedIds.length}件を除外予定に追加しました（「編集保存」を押すまで確定しません）`)
      } else {
        setExcludeMsg('除外対象がありませんでした')
      }
    } catch {
      setExcludeMsg('エラーが発生しました')
    } finally {
      setExcludeRunning((v) => ({ ...v, [key]: false }))
    }
  }

  // 除外APIは即座には呼ばず、除外予定として保持するだけにする。実際の
  // DELETEはsaveAll()でまとめて実行される。
  async function deleteExcludedProducts(productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) return []
    setPendingExcludeIds((prev) => {
      const next = new Set(prev)
      for (const id of productIds) next.add(id)
      return next
    })
    return productIds
  }

  // Vero・危険セラー・危険単語が依拠する抽出設定を取得する。パネルを開いた
  // 時点で先読みされているはずだが(dangerSettingsFetchedRef)、念のため
  // 未取得の場合はここで直接取得してフォールバックする。
  async function loadDangerSettings(): Promise<{ veroBrands: string[]; sellerUrls: string[]; words: string[] }> {
    if (dangerSettings) return dangerSettings
    const response = await fetch('/api/extraction-settings')
    if (!response.ok) throw new Error('抽出設定を取得できませんでした')
    const data = await response.json()
    const loaded = {
      veroBrands: (data.vero ?? [])
        .map((item: { brand?: unknown }) => typeof item.brand === 'string' ? item.brand : '')
        .filter(Boolean),
      sellerUrls: (data.sellers ?? []).map((s: { seller_url: string }) => s.seller_url),
      words: (data.words ?? []).map((w: { word: string }) => w.word),
    }
    setDangerSettings(loaded)
    return loaded
  }

  async function excludeVero(): Promise<string[]> {
    const { veroBrands } = await loadDangerSettings()
    return deleteExcludedProducts(findVeroProductIds(products, veroBrands))
  }

  async function excludeDangerSellers(): Promise<string[]> {
    const { sellerUrls } = await loadDangerSettings()
    return deleteExcludedProducts(findDangerSellerProductIds(products, sellerUrls))
  }

  function wordCheckFields(): KeywordMatchField[] {
    const fields: KeywordMatchField[] = []
    if (wordCheckTitle) fields.push('title')
    if (wordCheckBrand) fields.push('brand')
    if (wordCheckDescription) fields.push('description')
    return fields
  }

  async function excludeDangerWords(): Promise<string[]> {
    const { words } = await loadDangerSettings()
    return deleteExcludedProducts(findKeywordProductIds(products, words, wordCheckFields()))
  }

  async function excludeByPriceType(): Promise<string[]> {
    const selectedTypes = (Object.entries(priceTypesSelected) as [ProductPriceType, boolean][])
      .filter(([, selected]) => selected)
      .map(([type]) => type)
    return deleteExcludedProducts(findPriceTypeProductIds(products, selectedTypes))
  }

  function spotKeywords(): string[] {
    return [
      ...Array.from(spotSelected),
      ...spotCustom.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean),
    ]
  }

  function spotCheckFields(): KeywordMatchField[] {
    const fields: KeywordMatchField[] = []
    if (spotCheckTitle) fields.push('title')
    if (spotCheckBrand) fields.push('brand')
    if (spotCheckDescription) fields.push('description')
    return fields
  }

  async function excludeSpotWords(): Promise<string[]> {
    return deleteExcludedProducts(findKeywordProductIds(products, spotKeywords(), spotCheckFields()))
  }

  function quickKeywordList(): string[] {
    return quickKeywords.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean)
  }

  async function excludeQuick(): Promise<string[]> {
    return deleteExcludedProducts(findKeywordProductIds(products, quickKeywordList()))
  }

  async function excludeByPrice(): Promise<string[]> {
    const min = priceMin !== '' ? Number(priceMin) : null
    const max = priceMax !== '' ? Number(priceMax) : null
    return deleteExcludedProducts(findPriceRangeProductIds(products, min, max, priceTarget))
  }

  async function excludeByRating(): Promise<string[]> {
    const min = ratingMin !== '' ? Number(ratingMin) : null
    return deleteExcludedProducts(findLowRatingProductIds(products, min))
  }

  async function excludeByShippingDays(): Promise<string[]> {
    const max = shippingDaysMax !== '' ? Number(shippingDaysMax) : null
    return deleteExcludedProducts(findSlowShippingProductIds(products, max))
  }

  async function excludeByUpdatedAt(): Promise<string[]> {
    const months = Number(updatedMonthsAgo) || 3
    return deleteExcludedProducts(findStaleProductIds(products, months))
  }

  useEffect(() => {
    fetch(`/api/products/${extractionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setProducts(data)
        setLoading(false)
      })
  }, [extractionId])

  // Vero・危険セラー・危険単語パネルを開いた時点で抽出設定を1回だけ取得し、
  // 実行前の対象件数プレビューに使う(実行時にも同じキャッシュを再利用する)。
  useEffect(() => {
    if (!['vero', 'seller', 'word'].includes(excludePanel ?? '')) return
    if (dangerSettingsFetchedRef.current) return
    dangerSettingsFetchedRef.current = true

    fetch('/api/extraction-settings')
      .then((r) => r.json())
      .then((data) => {
        setDangerSettings({
          veroBrands: (data.vero ?? [])
            .map((item: { brand?: unknown }) => typeof item.brand === 'string' ? item.brand : '')
            .filter(Boolean),
          sellerUrls: (data.sellers ?? []).map((s: { seller_url: string }) => s.seller_url),
          words: (data.words ?? []).map((w: { word: string }) => w.word),
        })
      })
      .catch(() => {
        dangerSettingsFetchedRef.current = false // 失敗時は次回パネルを開いた際に再取得できるようにする
      })
  }, [excludePanel])

  // auto scroll
  useEffect(() => {
    if (autoScroll) {
      scrollTimer.current = setInterval(() => {
        scrollRef.current?.scrollBy({ top: scrollSpeed, behavior: 'auto' })
      }, 16)
    } else {
      if (scrollTimer.current) clearInterval(scrollTimer.current)
    }
    return () => { if (scrollTimer.current) clearInterval(scrollTimer.current) }
  }, [autoScroll, scrollSpeed])

  const updateEdit = useCallback((productId: string, field: string, value: unknown) => {
    setEdits((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }))
  }, [])

  // ---- 一括タイトル編集 ----
  function applyTitleEdit(op: TitleEditOp, scope: TitleEditScope) {
    const targets = scope === 'page'
      ? pagedProducts.map((p) => p.id)
      : products.map((p) => p.id)
    targets.forEach((id) => {
      const p = products.find((x) => x.id === id)
      if (!p) return
      const before = edits[id]?.ebay_title !== undefined ? (edits[id].ebay_title as string) : (p.ebay_title ?? '')
      // applyOp が常に80文字以内を返す
      const after = applyOp(before, op)
      updateEdit(id, 'ebay_title', after)
    })
  }

  // ---- 一括ブランド編集 ----
  function applyBrandEdit(brand: string | null, scope: BrandEditScope) {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((product) => updateEdit(product.id, 'ebay_brand', brand))
  }

  // ---- 一括商品詳細編集 ----
  function applyDescriptionEdit(op: DescriptionEditOp, scope: DescriptionEditScope) {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((product) => {
      updateEdit(product.id, 'ebay_description', applyDescriptionOp(getDescription(product), op))
    })
  }

  // ---- 一括画像枚数編集 ----
  function applyImageCountEdit(keepCount: number, scope: ImageCountEditScope) {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((product) => {
      const before = getImages(product)
      if (before.length > keepCount) {
        updateEdit(product.id, 'ebay_images', limitImages(before, keepCount))
      }
    })
  }

  // ---- 一括アイテムスペシフィック編集 ----
  function applyItemSpecificsEdit(
    specifics: ItemSpecifics,
    mode: ItemSpecificsEditMode,
    scope: ItemSpecificsEditScope,
  ) {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((product) => {
      updateEdit(
        product.id,
        'ebay_item_specifics',
        mode === 'clear' ? {} : mergeItemSpecifics(getItemSpecifics(product), specifics),
      )
    })
  }

  // ---- ポケモンカード専用設定 ----
  function applyPokemonEdit(
    specifics: ItemSpecifics,
    setBrand: boolean,
    scope: PokemonEditScope,
  ) {
    const targets = scope === 'page' ? pagedProducts : pokemonProducts
    targets.forEach((product) => {
      updateEdit(
        product.id,
        'ebay_item_specifics',
        mergeItemSpecifics(getItemSpecifics(product), specifics),
      )
      if (setBrand) updateEdit(product.id, 'ebay_brand', 'Pokémon')
    })
  }

  // ---- 一括価格編集 ----
  function applyPriceEdit(getPriceUsd: (p: Product) => number | null, scope: 'page' | 'all') {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((p) => {
      const price = getPriceUsd(p)
      if (price !== null) updateEdit(p.id, 'ebay_price', price)
    })
  }

  // ---- 一括商品状態編集 ----
  function applyConditionEdit(condition: string, scope: 'page' | 'all') {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((p) => updateEdit(p.id, 'ebay_condition', condition))
  }

  // ---- 一括保存 (Bulk API) ----
  // 除外予定商品の実際のDELETEを実行する。成功分だけpendingExcludeIdsから
  // 取り除き、失敗分は次回保存時に再試行できるよう保持する。
  async function flushPendingExcludes(): Promise<{ failedCount: number }> {
    const idsToDelete = Array.from(pendingExcludeIds)
    if (idsToDelete.length === 0) return { failedCount: 0 }

    const results = await Promise.all(idsToDelete.map(async (productId) => {
      // ゴミ箱ボタンで出品済み商品の強制削除が確認済みの場合はforce=trueを付与する。
      const force = forcedExcludeIds.has(productId)
      const response = await fetch(`/api/products/${extractionId}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, force }),
      })
      return { productId, ok: response.ok }
    }))

    const succeededIds = new Set(results.filter((r) => r.ok).map((r) => r.productId))
    const failedCount = results.length - succeededIds.size
    setPendingExcludeIds((prev) => {
      const next = new Set(prev)
      for (const id of succeededIds) next.delete(id)
      return next
    })
    setForcedExcludeIds((prev) => {
      const next = new Set(prev)
      for (const id of succeededIds) next.delete(id)
      return next
    })
    return { failedCount }
  }

  async function saveAll() {
    setSaving(true)
    setSaveError(null)
    try {
      const errors: string[] = []

      const { failedCount: excludeFailedCount } = await flushPendingExcludes()
      if (excludeFailedCount > 0) {
        errors.push(`${excludeFailedCount}件の除外の保存に失敗しました`)
      }

      const updates = Object.entries(edits).map(([productId, fields]) => {
        // タイトルは常に80文字以内
        const ebay_title = typeof fields.ebay_title === 'string'
          ? fields.ebay_title.slice(0, 80)
          : fields.ebay_title
        const out: Record<string, unknown> = { productId }
        if (ebay_title !== undefined) out.ebay_title = ebay_title
        if (fields.ebay_brand !== undefined) out.ebay_brand = fields.ebay_brand
        if (fields.ebay_description !== undefined) out.ebay_description = fields.ebay_description
        if (fields.ebay_images !== undefined) out.ebay_images = fields.ebay_images
        if (fields.ebay_item_specifics !== undefined) out.ebay_item_specifics = fields.ebay_item_specifics
        // null = 明示的クリア; 保存ボタンは不正価格がある間は無効なので、ここに届くのは null か正の有限数のみ
        if (fields.ebay_price !== undefined) out.ebay_price = fields.ebay_price
        if (fields.ebay_condition !== undefined) out.ebay_condition = fields.ebay_condition
        if (fields.purchase_price_jpy !== undefined) out.purchase_price_jpy = fields.purchase_price_jpy
        return out
      })

      if (updates.length > 0) {
        // 保存APIは一度に200件までしか受け付けないため、それより多い場合は
        // 分割して順番に送信する(ユーザー報告: 200件超で「一度に更新できるのは
        // 200件までです」というエラーになり保存が全く進まなかった)。
        const BULK_CHUNK_SIZE = 200
        const allSucceeded: string[] = []
        const allFailed: { productId: string; error: string }[] = []
        let hardError: string | null = null

        for (let i = 0; i < updates.length; i += BULK_CHUNK_SIZE) {
          const chunk = updates.slice(i, i + BULK_CHUNK_SIZE)
          const res = await fetch(`/api/products/${extractionId}/bulk`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: chunk }),
          })

          const json: { ok?: boolean; succeeded?: string[]; failed?: { productId: string; error: string }[]; error?: string }
            = await res.json().catch(() => ({}))

          if (json.ok === true) {
            allSucceeded.push(...chunk.map((u) => u.productId as string))
          } else if (json.succeeded && json.failed) {
            allSucceeded.push(...json.succeeded)
            allFailed.push(...json.failed)
          } else if (res.status === 401 || json.error === 'Unauthorized') {
            // ログインセッションが切れていると保存APIが401を返す。長時間の
            // 編集作業中に起こりやすいため、専用の分かりやすい文言を出す。
            // それ以上のチャンク送信は行わず、ここで打ち切る。
            hardError = 'ログインセッションが切れている可能性があります。ページを再読み込みしてから再度お試しください'
            break
          } else {
            // サーバーが具体的な理由(リクエスト形式エラー等)を返していても、
            // これまでは常に汎用的な「保存に失敗しました」と表示しており、
            // 原因が分からなかった。json.errorがあればそれを優先して表示する。
            hardError = typeof json.error === 'string'
              ? json.error
              : `保存に失敗しました (status: ${res.status})`
            break
          }
        }

        if (allSucceeded.length > 0) {
          const succeededSet = new Set(allSucceeded)
          setProducts((prev) =>
            prev.map((p) => (succeededSet.has(p.id) && edits[p.id] ? { ...p, ...edits[p.id] } : p))
          )
          setEdits((prev) => {
            const next = { ...prev }
            for (const id of succeededSet) delete next[id]
            return next
          })
        }

        if (allFailed.length > 0) {
          const firstErrors = allFailed.slice(0, 3).map((f) => `${f.productId.slice(0, 8)}: ${f.error}`).join(' / ')
          errors.push(`${allFailed.length}件の保存に失敗しました — ${firstErrors}`)
        }
        if (hardError) errors.push(hardError)
      }

      if (errors.length > 0) setSaveError(errors.join(' / '))
    } catch (e) {
      setSaveError(`通信エラー: ${e instanceof Error ? e.message : '不明なエラー'}`)
    } finally {
      setSaving(false)
    }
  }

  // ゴミ箱ボタンでの商品削除も除外と同様、実際のDELETEはsaveAll()まで保留する。
  // ただし出品済み商品かどうかの判定(409)はクリック時点で行い、その場合のみ
  // 従来通り強制削除の確認ダイアログを出す(?check=trueで実際には削除しない)。
  async function deleteProduct(productId: string) {
    if (!confirm('この商品を削除しますか？（「編集保存」を押すまで確定しません）')) return
    const res = await fetch(`/api/products/${extractionId}?check=true`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId }),
    })
    if (res.status === 409) {
      const json = await res.json().catch(() => ({})) as {
        error?: string
        blockedProducts?: { id: string; title: string }[]
      }
      const titles = (json.blockedProducts ?? []).map(product => `・${product.title}`).join('\n')
      const warning = [
        json.error ?? '出品済みの商品です。',
        titles,
        'eBay側のリスティングは削除されず、今後この商品の自動照合ができなくなります。',
        'それでも除外予定に追加しますか？（「編集保存」を押すまで確定しません）',
      ].filter(Boolean).join('\n\n')
      if (!confirm(warning)) return
      setForcedExcludeIds((prev) => new Set(prev).add(productId))
    } else if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { error?: string }
      alert(`削除に失敗しました: ${json.error ?? res.status}`)
      return
    }
    setPendingExcludeIds((prev) => new Set(prev).add(productId))
    setProducts((prev) => prev.filter((p) => p.id !== productId))
  }

  const getTitle = (p: Product) =>
    edits[p.id]?.ebay_title !== undefined ? (edits[p.id].ebay_title as string) : (p.ebay_title ?? '')
  const getBrand = (p: Product) =>
    edits[p.id]?.ebay_brand !== undefined ? (edits[p.id].ebay_brand as string | null) ?? '' : (p.ebay_brand ?? '')
  const getDescription = (p: Product) =>
    edits[p.id]?.ebay_description !== undefined
      ? (edits[p.id].ebay_description as string | null) ?? ''
      : (p.ebay_description ?? '')
  const getImages = (p: Product): string[] =>
    edits[p.id]?.ebay_images !== undefined
      ? (edits[p.id].ebay_images as string[])
      : (p.ebay_images?.length ? p.ebay_images : (p.original_images ?? []))
  const getItemSpecifics = (p: Product): ItemSpecifics =>
    edits[p.id]?.ebay_item_specifics !== undefined
      ? (edits[p.id].ebay_item_specifics as ItemSpecifics)
      : (p.ebay_item_specifics ?? {})
  const getPrice = (p: Product): number | null =>
    edits[p.id]?.ebay_price !== undefined ? (edits[p.id].ebay_price as number | null) : p.ebay_price

  const productsForSearch = products.map((product) => (
    edits[product.id] ? { ...product, ...edits[product.id] } : product
  ))
  const pokemonProducts = productsForSearch.filter(isPokemonProduct)
  const visibleProducts = tab === 'search'
    ? filterProducts(productsForSearch, searchFilters)
    : tab === 'pokemon'
      ? pokemonProducts
      : products
  const totalPages = Math.max(1, Math.ceil(visibleProducts.length / pageSize))
  const pagedProducts = visibleProducts.slice((page - 1) * pageSize, page * pageSize)
  const pagedIds = new Set(pagedProducts.map((p) => p.id))

  // 不正価格: edits に入っているが null でもなく正の有限数でもない
  const hasPriceError = Object.values(edits).some((fields) => {
    const p = fields.ebay_price
    return p !== undefined && p !== null && (typeof p !== 'number' || !isFinite(p) || p <= 0)
  })
  // 不正仕入価格: edits に入っているが null でもなく0以上の有限数でもない
  const hasPurchasePriceError = Object.values(edits).some((fields) => {
    const p = fields.purchase_price_jpy
    return p !== undefined && p !== null && (typeof p !== 'number' || !isFinite(p) || p < 0)
  })
  const hasBrandError = Object.values(edits).some((fields) => {
    const brand = fields.ebay_brand
    return typeof brand === 'string' && (brand.trim().length === 0 || brand.length > 65)
  })
  const hasDescriptionError = Object.values(edits).some((fields) => {
    const description = fields.ebay_description
    return typeof description === 'string'
      && (description.trim().length === 0 || description.length > DESCRIPTION_MAX_LENGTH)
  })
  const getCondition = (p: Product) =>
    (edits[p.id]?.ebay_condition as string | undefined) ?? p.ebay_condition ?? '中古'
  // purchase_price_jpy が優先; なければ original_price を表示専用に使用
  const getPurchaseJpy = (p: Product): number | null => {
    const fromEdit = edits[p.id]?.purchase_price_jpy
    if (fromEdit !== undefined) return fromEdit
    if (p.purchase_price_jpy != null) return p.purchase_price_jpy
    return p.original_price ?? null
  }

  // 除外パネルの「実行」前に、全{products.length}件中いくつが対象かを
  // プレビュー表示するための件数。実行時に使う関数と同じ判定ロジック
  // (src/lib/product-exclusion.ts)を使うため、プレビューと実際の除外結果が
  // 食い違うことはない。
  const veroPreviewCount = dangerSettings ? findVeroProductIds(products, dangerSettings.veroBrands).length : null
  const sellerPreviewCount = dangerSettings ? findDangerSellerProductIds(products, dangerSettings.sellerUrls).length : null
  const wordPreviewCount = dangerSettings ? findKeywordProductIds(products, dangerSettings.words, wordCheckFields()).length : null
  const spotPreviewCount = findKeywordProductIds(products, spotKeywords(), spotCheckFields()).length
  const quickPreviewCount = findKeywordProductIds(products, quickKeywordList()).length
  const pricePreviewCount = findPriceRangeProductIds(
    products,
    priceMin !== '' ? Number(priceMin) : null,
    priceMax !== '' ? Number(priceMax) : null,
    priceTarget,
  ).length
  const ratingPreviewCount = findLowRatingProductIds(products, ratingMin !== '' ? Number(ratingMin) : null).length
  const shippingPreviewCount = findSlowShippingProductIds(products, shippingDaysMax !== '' ? Number(shippingDaysMax) : null).length
  const updatedPreviewCount = findStaleProductIds(products, Number(updatedMonthsAgo) || 3).length

  return (
    <div className="border rounded-lg bg-white mt-2 shadow-sm">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <button
          onClick={onClose}
          className="text-sm text-gray-600 hover:text-gray-900 font-medium"
        >
          閉じる
        </button>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-gray-400 hover:text-gray-700"
        >
          {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* タブ */}
          <div className="flex gap-6 px-4 border-b">
            {([['main', 'メイン'], ['exclude', '除外'], ['edit', '編集'], ['search', '検索'], ['pokemon', 'ポケモン']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setTab(key)
                  setPage(1)
                }}
                className={`py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  tab === key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* メインタブ コントロール */}
          {tab === 'main' && (
            <div className="flex items-center gap-4 px-4 py-3 border-b bg-gray-50 flex-wrap">
              {/* 画像サイズ */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">画像サイズ</span>
                <select
                  value={imageSize}
                  onChange={(e) => setImageSize(e.target.value as ImageSize)}
                  className="border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                >
                  {(['小', '中', '大'] as ImageSize[]).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              {/* 一括サイズ */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">一括サイズ</span>
                <input
                  type="number"
                  value={bulkSize}
                  onChange={(e) => setBulkSize(e.target.value)}
                  className="border rounded px-2 py-1 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <button className="border border-blue-400 text-blue-500 rounded px-2.5 py-1 text-xs hover:bg-blue-50">
                  ✓ 適用
                </button>
              </div>
              {/* 編集モード */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">編集モード</span>
                <select
                  value={editMode}
                  onChange={(e) => setEditMode(e.target.value as EditMode)}
                  className="border-2 border-gray-800 rounded px-2 py-1 text-xs font-medium focus:outline-none"
                >
                  <option>簡易編集モード</option>
                  <option>詳細編集モード</option>
                </select>
              </div>
              {/* 編集保存 */}
              {pendingExcludeIds.size > 0 && (
                <span className="text-xs text-amber-600">保存待ちの除外: {pendingExcludeIds.size}件</span>
              )}
              <button
                onClick={saveAll}
                disabled={saving || (Object.keys(edits).length === 0 && pendingExcludeIds.size === 0) || hasPriceError || hasPurchasePriceError || hasBrandError || hasDescriptionError}
                className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1 text-xs font-medium transition-colors"
              >
                💾 編集保存
              </button>
              {saveError && (
                <span className="text-xs text-red-500">{saveError}</span>
              )}
            </div>
          )}

          {/* 除外タブ */}
          {tab === 'exclude' && (
            <div className="border-b bg-gray-50">
              <div className="px-4 py-4 grid grid-cols-5 gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">Vero</span>
                  <button type="button" aria-label="Veroを除外" onClick={() => togglePanel('vero')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'vero' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['vero'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険セラー</span>
                  <button type="button" aria-label="危険セラーを除外" onClick={() => togglePanel('seller')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'seller' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['seller'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険単語</span>
                  <button type="button" aria-label="危険単語を除外" onClick={() => togglePanel('word')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'word' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['word'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">スポット文字</span>
                  <button type="button" aria-label="スポット文字を除外" onClick={() => togglePanel('spot')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'spot' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['spot'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">評価数</span>
                  <button type="button" onClick={() => togglePanel('rating')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'rating' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['rating'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">発送日数</span>
                  <button type="button" onClick={() => togglePanel('shipping')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'shipping' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['shipping'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">最終更新月</span>
                  <button type="button" onClick={() => togglePanel('updated')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'updated' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['updated'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">価格タイプ</span>
                  <button type="button" aria-label="価格タイプを除外" onClick={() => togglePanel('priceType')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'priceType' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['priceType'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">価格範囲</span>
                  <button type="button" onClick={() => togglePanel('price')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'price' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['price'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">簡易除外</span>
                  <button type="button" onClick={() => togglePanel('quick')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'quick' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                  {excludeDone['quick'] && <span className="text-green-600" aria-label="除外済み">✓</span>}
                </div>
              </div>

              {excludePanel === 'vero' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">
                    抽出設定のVeroブランドと、eBayブランドまたは商品タイトルが一致する商品を除外します。
                  </p>
                  <p className="text-xs text-gray-600">
                    {dangerSettings === null
                      ? '対象件数を確認中...'
                      : <>全{products.length}件中 <strong className="text-gray-900">{veroPreviewCount}件</strong>が対象です</>}
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['vero']} onClick={() => runExclude('vero', excludeVero)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['vero'] ? '実行中...' : 'Vero除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'seller' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">
                    抽出危険設定に登録した危険セラーの商品を除外します。
                  </p>
                  <p className="text-xs text-gray-600">
                    {dangerSettings === null
                      ? '対象件数を確認中...'
                      : <>全{products.length}件中 <strong className="text-gray-900">{sellerPreviewCount}件</strong>が対象です</>}
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['seller']} onClick={() => runExclude('seller', excludeDangerSellers)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['seller'] ? '実行中...' : '危険セラー除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'word' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <div className="flex items-center gap-5">
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={wordCheckTitle} onChange={(e) => setWordCheckTitle(e.target.checked)} />
                      タイトルに含む
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={wordCheckBrand} onChange={(e) => setWordCheckBrand(e.target.checked)} />
                      ブランドに含む
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={wordCheckDescription} onChange={(e) => setWordCheckDescription(e.target.checked)} />
                      商品詳細に含む
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['word'] || wordCheckFields().length === 0}
                      onClick={() => runExclude('word', excludeDangerWords)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['word'] ? '実行中...' : '危険単語除外を実行'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-600">
                    {dangerSettings === null
                      ? '対象件数を確認中...'
                      : <>全{products.length}件中 <strong className="text-gray-900">{wordPreviewCount}件</strong>が対象です</>}
                  </p>
                  <p className="text-xs text-gray-500">
                    抽出危険設定に登録した危険単語が含まれている商品を除外します。大文字小文字関係なく除外されます。
                  </p>
                </div>
              )}

              {excludePanel === 'priceType' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-3">
                  <p className="text-xs text-gray-500">選択した販売形式の商品を除外します。</p>
                  <div className="flex items-center gap-5">
                    {([
                      ['fixed', '固定価格'],
                      ['auction', 'オークション'],
                    ] as const).map(([type, label]) => (
                      <label key={type} className="flex items-center gap-2 text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={priceTypesSelected[type]}
                          onChange={(event) => setPriceTypesSelected((current) => ({
                            ...current,
                            [type]: event.target.checked,
                          }))}
                        />
                        {label}（{products.filter((product) => getProductPriceType(product) === type).length}件）
                      </label>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={excludeRunning['priceType'] || !Object.values(priceTypesSelected).some(Boolean)}
                      onClick={() => runExclude('priceType', excludeByPriceType)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {excludeRunning['priceType'] ? '実行中...' : '価格タイプ除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'rating' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">セラーの総合評価数がN件未満の商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-600">評価数</span>
                    <input type="number" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)}
                      placeholder="例: 10" min="0"
                      className="border rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                    <span className="text-xs text-gray-500">件未満を除外</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{ratingPreviewCount}件</strong>が対象です
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['rating']} onClick={() => runExclude('rating', excludeByRating)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['rating'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'shipping' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">発送まで指定日数より長い商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-600">発送日数</span>
                    <input type="number" value={shippingDaysMax} onChange={(e) => setShippingDaysMax(e.target.value)}
                      placeholder="例: 3" min="1"
                      className="border rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                    <span className="text-xs text-gray-500">日超を除外</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{shippingPreviewCount}件</strong>が対象です
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['shipping']} onClick={() => runExclude('shipping', excludeByShippingDays)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['shipping'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'updated' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">最終更新が古い商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <select value={updatedMonthsAgo} onChange={(e) => setUpdatedMonthsAgo(e.target.value)}
                      className="border rounded px-2 py-1 text-xs focus:outline-none">
                      {[1, 2, 3, 6, 12].map((n) => (
                        <option key={n} value={String(n)}>{n}ヶ月以上前</option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-500">に更新された商品を除外</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{updatedPreviewCount}件</strong>が対象です
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['updated']} onClick={() => runExclude('updated', excludeByUpdatedAt)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['updated'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'spot' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {SPOT_PRESETS.map((w) => (
                      <button key={w} type="button"
                        onClick={() => setSpotSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(w)) next.delete(w)
                          else next.add(w)
                          return next
                        })}
                        className={`px-2 py-0.5 rounded text-xs border transition-colors ${spotSelected.has(w) ? 'bg-orange-500 text-white border-orange-500' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                        {w}
                      </button>
                    ))}
                  </div>
                  <input type="text" value={spotCustom} onChange={(e) => setSpotCustom(e.target.value)}
                    placeholder="カスタムキーワード（カンマ区切り）"
                    className="w-full border rounded px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  <div className="flex items-center gap-5">
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={spotCheckTitle} onChange={(e) => setSpotCheckTitle(e.target.checked)} />
                      タイトルに含む
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={spotCheckBrand} onChange={(e) => setSpotCheckBrand(e.target.checked)} />
                      ブランドに含む
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={spotCheckDescription} onChange={(e) => setSpotCheckDescription(e.target.checked)} />
                      商品詳細に含む
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['spot'] || spotCheckFields().length === 0} onClick={() => runExclude('spot', excludeSpotWords)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['spot'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{spotPreviewCount}件</strong>が対象です
                  </p>
                </div>
              )}

              {excludePanel === 'price' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">対象</span>
                      <select value={priceTarget} onChange={(e) => setPriceTarget(e.target.value as 'original' | 'ebay')}
                        className="border rounded px-2 py-1 text-xs focus:outline-none">
                        <option value="original">仕入れ価格（円）</option>
                        <option value="ebay">eBay価格（$）</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)}
                        placeholder="最小" className="border rounded px-2 py-1 text-xs w-24 focus:outline-none" />
                      <span className="text-xs text-gray-400">〜</span>
                      <input type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)}
                        placeholder="最大" className="border rounded px-2 py-1 text-xs w-24 focus:outline-none" />
                      <span className="text-xs text-gray-500">{priceTarget === 'original' ? '円' : '$'} の範囲外を除外</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{pricePreviewCount}件</strong>が対象です
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['price']} onClick={() => runExclude('price', excludeByPrice)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['price'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'quick' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <textarea value={quickKeywords} onChange={(e) => setQuickKeywords(e.target.value)}
                    placeholder="キーワードをカンマ・改行区切りで入力（タイトルに含む商品を除外）"
                    rows={3}
                    className="w-full border rounded px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none" />
                  <p className="text-xs text-gray-600">
                    全{products.length}件中 <strong className="text-gray-900">{quickPreviewCount}件</strong>が対象です
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['quick']} onClick={() => runExclude('quick', excludeQuick)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['quick'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludeMsg && (
                <p className="mx-4 mb-4 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{excludeMsg}</p>
              )}

              <div className="mx-4 mb-4 flex items-center justify-end gap-3">
                {pendingExcludeIds.size > 0 && (
                  <span className="text-xs text-amber-600">保存待ちの除外: {pendingExcludeIds.size}件</span>
                )}
                <button
                  onClick={saveAll}
                  disabled={saving || (Object.keys(edits).length === 0 && pendingExcludeIds.size === 0) || hasPriceError || hasPurchasePriceError || hasBrandError || hasDescriptionError}
                  className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  💾 編集保存
                </button>
                {saveError && (
                  <span className="text-xs text-red-500">{saveError}</span>
                )}
              </div>
            </div>
          )}

          {/* 編集タブ */}
          {tab === 'edit' && (
            <div className="px-4 py-4 border-b bg-gray-50">
              <div className="grid grid-cols-5 gap-3">
                {/* タイトル — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">タイトル</span>
                  <button onClick={() => setTitleModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* ブランド — Phase 2 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">ブランド</span>
                  <button onClick={() => setBrandModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* 商品詳細 — Phase 3 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">商品詳細</span>
                  <button onClick={() => setDescriptionModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* 画像枚数以降 — Phase 4 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">画像枚数以降</span>
                  <button aria-label="画像枚数以降を編集" onClick={() => setImageCountModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* 商品状態 — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">商品状態</span>
                  <button onClick={() => setConditionModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* 価格 — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">価格</span>
                  <button onClick={() => setPriceModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* アイテムスペシフィック — Phase 6 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">アイテムスペシフィック</span>
                  <button
                    type="button"
                    aria-label="アイテムスペシフィックを編集"
                    onClick={() => setItemSpecificsModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50"
                  >
                    編集
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-end gap-3">
                {pendingExcludeIds.size > 0 && (
                  <span className="text-xs text-amber-600">保存待ちの除外: {pendingExcludeIds.size}件</span>
                )}
                <button
                  onClick={saveAll}
                  disabled={saving || (Object.keys(edits).length === 0 && pendingExcludeIds.size === 0) || hasPriceError || hasPurchasePriceError || hasBrandError || hasDescriptionError}
                  className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  💾 編集保存
                </button>
                {saveError && (
                  <span className="text-xs text-red-500">{saveError}</span>
                )}
              </div>
            </div>
          )}

          {/* 検索タブ */}
          {tab === 'search' && (
            <div className="px-4 py-4 border-b bg-gray-50 space-y-3">
              <div className="flex items-center gap-3">
                <input
                  type="search"
                  aria-label="商品検索キーワード"
                  value={searchFilters.query}
                  onChange={(event) => updateSearchFilter('query', event.target.value)}
                  placeholder="タイトル、ブランド、商品ID、URL、商品詳細、アイテムスペシフィック"
                  className="flex-1 min-w-0 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <button
                  type="button"
                  onClick={resetSearchFilters}
                  className="border border-gray-300 rounded px-3 py-2 text-xs text-gray-600 hover:bg-white"
                >
                  条件をリセット
                </button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <label className="space-y-1">
                  <span className="block text-xs text-gray-500">サイト</span>
                  <select
                    aria-label="検索サイト"
                    value={searchFilters.sourceSite}
                    onChange={(event) => updateSearchFilter('sourceSite', event.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="all">すべて</option>
                    {Array.from(new Set(products.map((product) => product.source_site))).sort().map((site) => (
                      <option key={site} value={site}>{site}</option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="block text-xs text-gray-500">商品状態</span>
                  <select
                    aria-label="検索商品状態"
                    value={searchFilters.condition}
                    onChange={(event) => updateSearchFilter('condition', event.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="all">すべて</option>
                    {['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'].map((condition) => (
                      <option key={condition} value={condition}>{condition}</option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="block text-xs text-gray-500">価格タイプ</span>
                  <select
                    aria-label="検索価格タイプ"
                    value={searchFilters.priceType}
                    onChange={(event) => updateSearchFilter('priceType', event.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="all">すべて</option>
                    <option value="fixed">固定価格</option>
                    <option value="auction">オークション</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="block text-xs text-gray-500">eBay価格</span>
                  <select
                    aria-label="eBay価格設定状態"
                    value={searchFilters.priceState}
                    onChange={(event) => updateSearchFilter(
                      'priceState',
                      event.target.value as ProductSearchFilters['priceState'],
                    )}
                    className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="all">すべて</option>
                    <option value="set">設定済み</option>
                    <option value="unset">未設定</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="block text-xs text-gray-500">価格の対象</span>
                  <select
                    aria-label="検索価格対象"
                    value={searchFilters.priceTarget}
                    onChange={(event) => updateSearchFilter(
                      'priceTarget',
                      event.target.value as ProductSearchFilters['priceTarget'],
                    )}
                    className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="original">仕入価格（円）</option>
                    <option value="ebay">eBay価格（$）</option>
                  </select>
                </label>

                <div className="space-y-1">
                  <span className="block text-xs text-gray-500">価格範囲</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      aria-label="検索最低価格"
                      min="0"
                      value={searchFilters.priceMin}
                      onChange={(event) => updateSearchFilter('priceMin', event.target.value)}
                      placeholder="最小"
                      className="w-full min-w-0 border rounded px-2 py-1.5 text-xs"
                    />
                    <span className="text-xs text-gray-400">〜</span>
                    <input
                      type="number"
                      aria-label="検索最高価格"
                      min="0"
                      value={searchFilters.priceMax}
                      onChange={(event) => updateSearchFilter('priceMax', event.target.value)}
                      placeholder="最大"
                      className="w-full min-w-0 border rounded px-2 py-1.5 text-xs"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-600">
                  {products.length}件中 <span className="font-semibold text-blue-600">{visibleProducts.length}件</span> を表示
                </p>
                <div className="flex items-center gap-3">
                  {pendingExcludeIds.size > 0 && (
                    <span className="text-xs text-amber-600">保存待ちの除外: {pendingExcludeIds.size}件</span>
                  )}
                  <button
                    type="button"
                    onClick={saveAll}
                    disabled={saving || (Object.keys(edits).length === 0 && pendingExcludeIds.size === 0) || hasPriceError || hasPurchasePriceError || hasBrandError || hasDescriptionError}
                    className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium"
                  >
                    💾 編集保存
                  </button>
                  {saveError && <span className="text-xs text-red-500">{saveError}</span>}
                </div>
              </div>
            </div>
          )}

          {/* ポケモンタブ */}
          {tab === 'pokemon' && (
            <>
              <PokemonEditPanel
                products={pokemonProducts}
                pagedIds={pagedIds}
                onApply={applyPokemonEdit}
              />
              <div className="flex items-center justify-end gap-3 px-4 py-3 border-b bg-gray-50">
                {pendingExcludeIds.size > 0 && (
                  <span className="text-xs text-amber-600">保存待ちの除外: {pendingExcludeIds.size}件</span>
                )}
                <button
                  type="button"
                  onClick={saveAll}
                  disabled={saving || (Object.keys(edits).length === 0 && pendingExcludeIds.size === 0) || hasPriceError || hasPurchasePriceError || hasBrandError || hasDescriptionError}
                  className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium"
                >
                  💾 編集保存
                </button>
                {saveError && <span className="text-xs text-red-500">{saveError}</span>}
              </div>
            </>
          )}

          {/* 商品リスト */}
          {(tab === 'main' || tab === 'exclude' || tab === 'edit' || tab === 'search' || tab === 'pokemon') && (
            <div ref={scrollRef} className="overflow-y-auto max-h-[70vh]">
              {loading ? (
                <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
              ) : pagedProducts.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400">
                  {tab === 'search'
                    ? '検索条件に一致する商品がありません'
                    : tab === 'pokemon'
                      ? 'ポケモン商品がありません'
                      : '商品がありません'}
                </div>
              ) : (
                pagedProducts.map((product) => (
                  <div key={product.id} className="border-b last:border-0 px-4 py-4">
                    <div className="flex gap-4">
                      {/* アクションボタン */}
                      <div className="flex flex-col gap-2 items-center pt-1 shrink-0">
                        <button
                          aria-label={`${product.original_title}を削除`}
                          onClick={() => deleteProduct(product.id)}
                          className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center"
                        >
                          <Trash2 size={14} />
                        </button>
                        <a
                          href={product.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center"
                        >
                          <Link size={14} />
                        </a>
                      </div>

                      {/* メイン画像 */}
                      <div className={`shrink-0 ${IMAGE_SIZE_MAP[imageSize]}`}>
                        {getImages(product)[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- Marketplace image hosts are dynamic and cannot be safely allowlisted for next/image.
                          <img
                            src={getImages(product)[0]}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover rounded border"
                          />
                        ) : (
                          <div className="w-full h-full bg-gray-100 rounded border flex items-center justify-center text-gray-300 text-xs">No image</div>
                        )}
                      </div>

                      {/* 編集フィールド */}
                      <div className="flex-1 grid grid-cols-[1fr_200px] gap-4">
                        {/* 左: タイトル */}
                        <div>
                          <div className="relative">
                            <input
                              type="text"
                              value={getTitle(product)}
                              onChange={(e) => updateEdit(product.id, 'ebay_title', e.target.value.slice(0, 80))}
                              maxLength={80}
                              placeholder="翻訳後タイトル"
                              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                            />
                            <span className={`absolute right-2 bottom-2 text-xs ${getTitle(product).length >= 80 ? 'text-red-400' : 'text-gray-400'}`}>
                              {getTitle(product).length} / 80
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-400 truncate">{product.original_title}</p>
                          {editMode === '詳細編集モード' && (
                            <div className="mt-3">
                              <label className="text-xs text-gray-500 block mb-1">
                                商品詳細
                                {getDescription(product) === '' && <span className="ml-1 text-amber-500">未設定</span>}
                              </label>
                              <textarea
                                value={getDescription(product)}
                                maxLength={DESCRIPTION_MAX_LENGTH}
                                rows={5}
                                onChange={(event) => {
                                  const value = event.target.value.slice(0, DESCRIPTION_MAX_LENGTH)
                                  updateEdit(product.id, 'ebay_description', value === '' ? null : value)
                                }}
                                placeholder="商品詳細未設定"
                                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y"
                              />
                              <p className="text-right text-xs text-gray-400">
                                {getDescription(product).length.toLocaleString()} / {DESCRIPTION_MAX_LENGTH.toLocaleString()}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* 右: ブランド・価格・状態 */}
                        <div className="space-y-2">
                          <div>
                            <label className="text-xs text-gray-500 block mb-0.5">
                              ブランド
                              {getBrand(product) === '' && <span className="ml-1 text-amber-500">ブランド未設定</span>}
                            </label>
                            <input
                              type="text"
                              value={getBrand(product)}
                              maxLength={65}
                              onChange={(event) => {
                                const value = event.target.value.slice(0, 65)
                                updateEdit(product.id, 'ebay_brand', value === '' ? null : value)
                              }}
                              placeholder="ブランド未設定"
                              className={`w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 ${
                                getBrand(product) !== '' && getBrand(product).trim().length === 0 ? 'border-red-400' : ''
                              }`}
                            />
                            {getBrand(product) !== '' && getBrand(product).trim().length === 0 && (
                              <p className="text-xs text-red-500 mt-0.5">空白以外の文字を入力してください</p>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">
                                eBay販売価格
                                {getPrice(product) == null && (
                                  <span className="ml-1 text-amber-500">未設定</span>
                                )}
                              </label>
                              <div className={`flex items-center border rounded overflow-hidden ${
                                getPrice(product) !== null && (getPrice(product)! <= 0 || !isFinite(getPrice(product)!))
                                  ? 'border-red-400' : ''
                              }`}>
                                <input
                                  type="number"
                                  value={getPrice(product) ?? ''}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    if (raw === '') {
                                      updateEdit(product.id, 'ebay_price', null)
                                    } else {
                                      const n = parseFloat(raw)
                                      // NaN → null (クリア扱い); 0・負数はそのまま保持してエラー表示
                                      updateEdit(product.id, 'ebay_price', isNaN(n) ? null : n)
                                    }
                                  }}
                                  placeholder="未設定"
                                  className="flex-1 px-2 py-1.5 text-sm focus:outline-none min-w-0"
                                />

                                <span className="px-2 text-xs text-gray-500 bg-gray-50 border-l h-full flex items-center">$</span>
                              </div>
                              {(() => {
                                const v = getPrice(product)
                                return v !== null && (v <= 0 || !isFinite(v))
                                  ? <p className="text-xs text-red-500 mt-0.5">0より大きい値を入力してください</p>
                                  : null
                              })()}
                            </div>
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">仕入価格</label>
                              <div className={`flex items-center border rounded overflow-hidden ${
                                getPurchaseJpy(product) !== null && (getPurchaseJpy(product)! < 0 || !isFinite(getPurchaseJpy(product)!))
                                  ? 'border-red-400' : ''
                              }`}>
                                <input
                                  type="number"
                                  value={getPurchaseJpy(product) ?? ''}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    if (raw === '') {
                                      updateEdit(product.id, 'purchase_price_jpy', null)
                                    } else {
                                      const n = parseFloat(raw)
                                      // NaN → null (クリア扱い); 負数はそのまま保持してエラー表示
                                      updateEdit(product.id, 'purchase_price_jpy', isNaN(n) ? null : n)
                                    }
                                  }}
                                  placeholder="仕入価格未設定"
                                  className="flex-1 px-2 py-1.5 text-sm focus:outline-none min-w-0"
                                />
                                <span className="px-2 text-xs text-gray-500 bg-gray-50 border-l h-full flex items-center">円</span>
                              </div>
                              {(() => {
                                const v = getPurchaseJpy(product)
                                return v !== null && (v < 0 || !isFinite(v))
                                  ? <p className="text-xs text-red-500 mt-0.5">0以上の値を入力してください</p>
                                  : null
                              })()}
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500 block mb-0.5">商品状態</label>
                            <select
                              value={getCondition(product)}
                              onChange={(e) => updateEdit(product.id, 'ebay_condition', e.target.value)}
                              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                            >
                              {['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'].map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* サムネイル */}
                    {getImages(product).length > 1 && (
                      <div className="flex gap-2 mt-3 ml-[5.5rem] overflow-x-auto pb-1">
                        {getImages(product).slice(0, 12).map((img, i) => (
                          // eslint-disable-next-line @next/next/no-img-element -- Marketplace image hosts are dynamic and cannot be safely allowlisted for next/image.
                          <img
                            key={i}
                            src={img}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="w-14 h-14 object-cover rounded border shrink-0"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* ボトムバー */}
          {(tab === 'main' || tab === 'exclude' || tab === 'edit' || tab === 'search' || tab === 'pokemon') && (
            <div className="flex items-center gap-3 px-4 py-3 border-t bg-gray-50 flex-wrap">
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={`border rounded px-3 py-1.5 text-xs transition-colors ${
                  autoScroll ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-gray-100'
                }`}
              >
                自動スクロール
              </button>
              <button onClick={() => setScrollSpeed((v) => Math.min(v + 2, 20))} className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100">加速</button>
              <button onClick={() => setScrollSpeed((v) => Math.max(v - 2, 1))} className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100">減速</button>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">スクロール速度</span>
                <input type="number" value={scrollSpeed} onChange={(e) => setScrollSpeed(Number(e.target.value))}
                  className="border rounded px-2 py-1 text-xs w-14 focus:outline-none" />
                <span className="text-xs text-gray-500">px</span>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">Items per page:</span>
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
                    className="border rounded px-2 py-1 text-xs focus:outline-none">
                    {PAGE_SIZE_OPTIONS.map((n) => <option key={n}>{n}</option>)}
                  </select>
                </div>
                <span className="text-xs text-gray-600">
                  {visibleProducts.length === 0 ? 0 : (page - 1) * pageSize + 1}-
                  {Math.min(page * pageSize, visibleProducts.length)} of {visibleProducts.length}
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(1)} disabled={page === 1} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">|◀</button>
                  <button onClick={() => setPage((v) => Math.max(v - 1, 1))} disabled={page === 1} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">◀</button>
                  <button onClick={() => setPage((v) => Math.min(v + 1, totalPages))} disabled={page === totalPages} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">▶</button>
                  <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">▶|</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* モーダル */}
      {titleModalOpen && (
        <TitleEditModal
          products={products}
          pagedIds={pagedIds}
          getTitle={getTitle}
          onApply={applyTitleEdit}
          onClose={() => setTitleModalOpen(false)}
        />
      )}
      {brandModalOpen && (
        <BrandEditModal
          products={products}
          pagedIds={pagedIds}
          getBrand={getBrand}
          onApply={applyBrandEdit}
          onClose={() => setBrandModalOpen(false)}
        />
      )}
      {descriptionModalOpen && (
        <DescriptionEditModal
          products={products}
          pagedIds={pagedIds}
          getDescription={getDescription}
          onApply={applyDescriptionEdit}
          onClose={() => setDescriptionModalOpen(false)}
        />
      )}
      {imageCountModalOpen && (
        <ImageCountEditModal
          products={products}
          pagedIds={pagedIds}
          getImages={getImages}
          onApply={applyImageCountEdit}
          onClose={() => setImageCountModalOpen(false)}
        />
      )}
      {itemSpecificsModalOpen && (
        <ItemSpecificsEditModal
          products={products}
          pagedIds={pagedIds}
          getItemSpecifics={getItemSpecifics}
          onApply={applyItemSpecificsEdit}
          onClose={() => setItemSpecificsModalOpen(false)}
        />
      )}
      {priceModalOpen && (
        <PriceEditModal
          products={products}
          pagedIds={pagedIds}
          getPurchaseJpy={getPurchaseJpy}
          onApply={applyPriceEdit}
          onClose={() => setPriceModalOpen(false)}
        />
      )}
      {conditionModalOpen && (
        <ConditionEditModal
          targetCount={{ page: pagedProducts.length, all: products.length }}
          onApply={applyConditionEdit}
          onClose={() => setConditionModalOpen(false)}
        />
      )}
    </div>
  )
}
