'use client'

import { useMemo, useState } from 'react'
import type { Product } from '@/types/database'
import {
  buildPokemonItemSpecifics,
} from '@/lib/pokemon'
import type { PokemonCardSettings } from '@/lib/pokemon'

export type PokemonEditScope = 'page' | 'all'

interface Props {
  products: Product[]
  pagedIds: Set<string>
  onApply: (
    specifics: Record<string, string[]>,
    setBrand: boolean,
    scope: PokemonEditScope,
  ) => void
}

const INITIAL_SETTINGS: PokemonCardSettings = {
  game: 'Pokémon TCG',
  cardName: '',
  setName: '',
  cardNumber: '',
  language: 'Japanese',
  finish: '',
  features: '',
  graded: 'No',
  grader: '',
  grade: '',
}

export default function PokemonEditPanel({ products, pagedIds, onApply }: Props) {
  const [settings, setSettings] = useState<PokemonCardSettings>(INITIAL_SETTINGS)
  const [scope, setScope] = useState<PokemonEditScope>('page')
  const [setBrand, setSetBrand] = useState(true)

  const pageProducts = products.filter((product) => pagedIds.has(product.id))
  const targetProducts = scope === 'page' ? pageProducts : products
  const specifics = useMemo(() => buildPokemonItemSpecifics(settings), [settings])
  const featureValues = settings.features
    .split(/[,、\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
  const hasFeatureError = featureValues.length > 10
    || featureValues.some((value) => value.length > 65)
  const hasGradingError = settings.graded === 'Yes'
    && (!settings.grader.trim() || !settings.grade.trim())
  const canApply = targetProducts.length > 0 && !hasFeatureError && !hasGradingError

  function updateSetting<K extends keyof PokemonCardSettings>(
    key: K,
    value: PokemonCardSettings[K],
  ) {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  return (
    <div className="px-4 py-4 border-b bg-amber-50/60 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">ポケモンカード専用設定</h3>
          <p className="mt-1 text-xs text-gray-500">
            タイトル・ブランド・商品詳細からポケモン商品を自動判定し、該当商品のみにeBay項目を設定します。
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-gray-500">自動判定</p>
          <p className="text-lg font-semibold text-amber-600">{products.length}件</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <label className="space-y-1">
          <span className="block text-xs text-gray-500">ゲーム</span>
          <select
            aria-label="ポケモンゲーム"
            value={settings.game}
            onChange={(event) => updateSetting('game', event.target.value)}
            className="w-full border rounded px-2 py-1.5 text-xs bg-white"
          >
            <option>Pokémon TCG</option>
            <option>Pokémon TCG Pocket</option>
            <option>Pokémon Card Game</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">カード名</span>
          <input
            aria-label="ポケモンカード名"
            value={settings.cardName}
            maxLength={65}
            onChange={(event) => updateSetting('cardName', event.target.value)}
            placeholder="例: Pikachu"
            className="w-full border rounded px-2 py-1.5 text-xs"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">セット</span>
          <input
            aria-label="ポケモンセット"
            value={settings.setName}
            maxLength={65}
            onChange={(event) => updateSetting('setName', event.target.value)}
            placeholder="例: Scarlet & Violet"
            className="w-full border rounded px-2 py-1.5 text-xs"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">カード番号</span>
          <input
            aria-label="ポケモンカード番号"
            value={settings.cardNumber}
            maxLength={65}
            onChange={(event) => updateSetting('cardNumber', event.target.value)}
            placeholder="例: 025/165"
            className="w-full border rounded px-2 py-1.5 text-xs"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">言語</span>
          <select
            aria-label="ポケモンカード言語"
            value={settings.language}
            onChange={(event) => updateSetting('language', event.target.value)}
            className="w-full border rounded px-2 py-1.5 text-xs bg-white"
          >
            {['Japanese', 'English', 'Chinese', 'Korean', 'French', 'German', 'Spanish', 'Italian'].map((language) => (
              <option key={language}>{language}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">加工</span>
          <select
            aria-label="ポケモンカード加工"
            value={settings.finish}
            onChange={(event) => updateSetting('finish', event.target.value)}
            className="w-full border rounded px-2 py-1.5 text-xs bg-white"
          >
            <option value="">指定なし</option>
            <option>Holo</option>
            <option>Reverse Holo</option>
            <option>Non-Holo</option>
          </select>
        </label>

        <label className="space-y-1 md:col-span-2">
          <span className="block text-xs text-gray-500">特徴（カンマ区切り）</span>
          <input
            aria-label="ポケモンカード特徴"
            value={settings.features}
            onChange={(event) => updateSetting('features', event.target.value)}
            placeholder="例: Full Art, Alternative Art"
            className={`w-full border rounded px-2 py-1.5 text-xs ${hasFeatureError ? 'border-red-400' : ''}`}
          />
          {hasFeatureError && (
            <span className="block text-xs text-red-500">特徴は10個以内、各65文字以内にしてください</span>
          )}
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-gray-500">鑑定</span>
          <select
            aria-label="ポケモンカード鑑定"
            value={settings.graded}
            onChange={(event) => updateSetting('graded', event.target.value as 'Yes' | 'No')}
            className="w-full border rounded px-2 py-1.5 text-xs bg-white"
          >
            <option value="No">未鑑定</option>
            <option value="Yes">鑑定済み</option>
          </select>
        </label>

        {settings.graded === 'Yes' && (
          <>
            <label className="space-y-1">
              <span className="block text-xs text-gray-500">鑑定会社</span>
              <select
                aria-label="ポケモンカード鑑定会社"
                value={settings.grader}
                onChange={(event) => updateSetting('grader', event.target.value)}
                className="w-full border rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="">選択してください</option>
                {['PSA', 'BGS', 'CGC', 'ARS', 'SGC'].map((grader) => (
                  <option key={grader}>{grader}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-gray-500">グレード</span>
              <select
                aria-label="ポケモンカードグレード"
                value={settings.grade}
                onChange={(event) => updateSetting('grade', event.target.value)}
                className="w-full border rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="">選択してください</option>
                {['10', '9.5', '9', '8.5', '8', '7.5', '7', '6', '5', '4', '3', '2', '1'].map((grade) => (
                  <option key={grade}>{grade}</option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {hasGradingError && (
        <p className="text-xs text-red-500">鑑定済みの場合は鑑定会社とグレードを選択してください</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-5">
          <span className="text-xs text-gray-500">適用範囲:</span>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="radio"
              checked={scope === 'page'}
              onChange={() => setScope('page')}
            />
            現在のページ（{pageProducts.length}件）
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="radio"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            ポケモン商品すべて（{products.length}件）
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={setBrand}
              onChange={(event) => setSetBrand(event.target.checked)}
            />
            ブランドを「Pokémon」に設定
          </label>
        </div>

        <button
          type="button"
          disabled={!canApply}
          onClick={() => onApply(specifics, setBrand, scope)}
          className="bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white rounded px-4 py-2 text-xs font-medium"
        >
          ポケモン設定を適用（{targetProducts.length}件）
        </button>
      </div>

      {products.length === 0 && (
        <p className="text-xs text-amber-700 bg-white border border-amber-200 rounded px-3 py-2">
          この抽出にはポケモン商品が見つかりませんでした。
        </p>
      )}
    </div>
  )
}
