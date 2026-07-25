import type { Product } from '@/types/database'

export interface PokemonCardSettings {
  game: string
  cardName: string
  setName: string
  cardNumber: string
  language: string
  finish: string
  features: string
  graded: 'Yes' | 'No'
  grader: string
  grade: string
}

const POKEMON_TERMS = [
  'pokemon',
  'pokémon',
  'ポケモン',
  'ポケットモンスター',
  'ポケカ',
  'pocket monsters',
]

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
}

function productText(product: Product): string {
  const specifics = Object.entries(product.ebay_item_specifics ?? {})
    .flatMap(([name, values]) => [name, ...values])

  return [
    product.original_title,
    product.ebay_title,
    product.original_description,
    product.ebay_description,
    product.ebay_brand,
    ...specifics,
  ].map(normalize).join(' ')
}

function splitValues(value: string): string[] {
  return [...new Set(
    value
      .split(/[,、\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  )]
}

export function isPokemonProduct(product: Product): boolean {
  const text = productText(product)
  return POKEMON_TERMS.some((term) => text.includes(term))
}

export function buildPokemonItemSpecifics(
  settings: PokemonCardSettings,
): Record<string, string[]> {
  const result: Record<string, string[]> = {
    Game: [settings.game.trim() || 'Pokémon TCG'],
    Language: [settings.language.trim() || 'Japanese'],
    Graded: [settings.graded],
  }

  const optional: Array<[string, string]> = [
    ['Card Name', settings.cardName],
    ['Set', settings.setName],
    ['Card Number', settings.cardNumber],
    ['Finish', settings.finish],
  ]
  for (const [name, value] of optional) {
    if (value.trim()) result[name] = [value.trim()]
  }

  const features = splitValues(settings.features)
  if (features.length > 0) result.Features = features

  if (settings.graded === 'Yes') {
    if (settings.grader.trim()) result['Professional Grader'] = [settings.grader.trim()]
    if (settings.grade.trim()) result.Grade = [settings.grade.trim()]
  }

  return result
}
