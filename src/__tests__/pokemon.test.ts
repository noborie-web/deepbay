import { describe, expect, it } from 'vitest'
import {
  buildPokemonItemSpecifics,
  isPokemonProduct,
} from '@/lib/pokemon'
import type { PokemonCardSettings } from '@/lib/pokemon'
import type { Product } from '@/types/database'

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: 'https://example.com/p1',
    source_site: 'mercari',
    source_item_id: 'p1',
    original_title: 'Trading card',
    original_price: 3000,
    original_description: null,
    original_images: [],
    original_condition: '中古',
    ebay_title: 'Trading Card',
    ebay_brand: null,
    ebay_price: null,
    ebay_description: null,
    ebay_images: [],
    ebay_item_specifics: {},
    ebay_condition: '中古',
    ebay_category_id: null,
    listing_status: 'draft',
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: null,
    price_type: 'fixed',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

const settings: PokemonCardSettings = {
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

describe('isPokemonProduct', () => {
  it('日本語の商品タイトルからポケモン商品を判定する', () => {
    expect(isPokemonProduct(makeProduct({
      original_title: 'ポケモンカード ピカチュウ',
    }))).toBe(true)
  })

  it('ブランドとアイテムスペシフィックも判定対象にする', () => {
    expect(isPokemonProduct(makeProduct({ ebay_brand: 'Pokémon' }))).toBe(true)
    expect(isPokemonProduct(makeProduct({
      ebay_item_specifics: { Game: ['Pokemon TCG'] },
    }))).toBe(true)
  })

  it('表記を正規化して判定する', () => {
    expect(isPokemonProduct(makeProduct({
      ebay_title: 'ＰＯＫＥＭＯＮ CARD',
    }))).toBe(true)
  })

  it('一般商品をポケモン商品と誤判定しない', () => {
    expect(isPokemonProduct(makeProduct({
      original_title: 'Tamiya Mini 4WD',
      ebay_title: 'Tamiya Model Car',
    }))).toBe(false)
  })
})

describe('buildPokemonItemSpecifics', () => {
  it('基本項目と任意入力項目をeBay商品項目へ変換する', () => {
    expect(buildPokemonItemSpecifics({
      ...settings,
      cardName: 'Pikachu',
      setName: 'Scarlet & Violet',
      cardNumber: '025/165',
      finish: 'Holo',
    })).toEqual({
      Game: ['Pokémon TCG'],
      Language: ['Japanese'],
      Graded: ['No'],
      'Card Name': ['Pikachu'],
      Set: ['Scarlet & Violet'],
      'Card Number': ['025/165'],
      Finish: ['Holo'],
    })
  })

  it('特徴を分割して重複を除く', () => {
    expect(buildPokemonItemSpecifics({
      ...settings,
      features: 'Full Art, Holo、Full Art\nPromo',
    }).Features).toEqual(['Full Art', 'Holo', 'Promo'])
  })

  it('鑑定済みでは鑑定会社とグレードを追加する', () => {
    expect(buildPokemonItemSpecifics({
      ...settings,
      graded: 'Yes',
      grader: 'PSA',
      grade: '10',
    })).toMatchObject({
      Graded: ['Yes'],
      'Professional Grader': ['PSA'],
      Grade: ['10'],
    })
  })

  it('未鑑定では鑑定会社とグレードを含めない', () => {
    const result = buildPokemonItemSpecifics({
      ...settings,
      grader: 'PSA',
      grade: '10',
    })
    expect(result).not.toHaveProperty('Professional Grader')
    expect(result).not.toHaveProperty('Grade')
  })
})
