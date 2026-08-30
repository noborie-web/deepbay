// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// ---------- モック ----------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}))

vi.mock('lucide-react', () => ({
  Trash2: () => null,
  Link: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------- テスト用製品ファクトリ ----------

function makeProduct(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`,
    source_site: 'mercari',
    source_item_id: id,
    original_title: `Original Title ${id}`,
    original_price: 3000,
    original_description: null,
    original_images: [],
    original_condition: null,
    ebay_title: `eBay Title ${id}`,
    ebay_brand: null,
    ebay_price: null,
    ebay_description: null,
    ebay_images: [],
    ebay_item_specifics: {},
    ebay_condition: '中古',
    ebay_category_id: null,
    listing_status: 'draft' as const,
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: null,
    price_type: 'fixed' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ProductEditPanel: 未実装だった除外機能', () => {
  it('Veroブランドに一致する商品だけを除外する', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeProduct('p1', { ebay_brand: 'Nintendo' }),
          makeProduct('p2', { ebay_brand: 'Generic' }),
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ vero: [{ brand: 'Nintendo' }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Veroを除外' }))
    await userEvent.click(screen.getByRole('button', { name: 'Vero除外を実行' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock.mock.calls[2][0]).toBe('/api/products/ext-1')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ productId: 'p1' })
    await waitFor(() => expect(screen.queryByDisplayValue('eBay Title p1')).toBeNull())
    expect(screen.getByDisplayValue('eBay Title p2')).toBeTruthy()
  })

  it('価格タイプの初期選択ではオークション商品だけを除外する', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeProduct('p1', { price_type: 'fixed' }),
          makeProduct('p2', { price_type: 'auction' }),
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    await userEvent.click(screen.getByRole('button', { name: '価格タイプを除外' }))
    expect(screen.getByRole('checkbox', { name: '固定価格（1件）' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'オークション（1件）' })).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '価格タイプ除外を実行' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ productId: 'p2' })
    await waitFor(() => expect(screen.queryByDisplayValue('eBay Title p2')).toBeNull())
    expect(screen.getByDisplayValue('eBay Title p1')).toBeTruthy()
  })

  // ユーザー報告: 「Vero除外したら、その他の除外クリックしてもVeroから変わらない」。
  // 原因は「危険セラー」「危険単語」ボタンだけ他の除外ボタンと違いtogglePanelを
  // 呼ばず即実行する仕様だったため、Veroパネルを開いた状態でこれらを押しても
  // パネル表示が切り替わらなかった(APIは裏で呼ばれているが画面上変化がない)。
  // 他の除外ボタンと同様にパネルを開閉する方式に統一して修正した。
  it('Vero除外実行後に「危険セラー」ボタンを押すと、危険セラーの確認パネルに切り替わる', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct('p1', { ebay_brand: 'Nintendo' })],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ vero: [] }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Veroを除外' }))
    await userEvent.click(screen.getByRole('button', { name: 'Vero除外を実行' }))
    await waitFor(() => screen.getByText('除外対象がありませんでした'))
    expect(screen.getByText(/抽出設定のVeroブランドと/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '危険セラーを除外' }))

    expect(screen.queryByText(/抽出設定のVeroブランドと/)).not.toBeInTheDocument()
    expect(screen.getByText(/抽出危険設定に登録した危険セラー/)).toBeInTheDocument()
    // 確認パネル内の実行ボタンを押すまでは除外APIは呼ばれない。
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('「危険セラー除外を実行」を押すと除外APIが呼ばれ、対象商品が除外される', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct('p1', { source_url: 'https://example.com/danger/p1' })],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sellers: [{ seller_url: 'https://example.com/danger' }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    await userEvent.click(screen.getByRole('button', { name: '危険セラーを除外' }))
    await userEvent.click(screen.getByRole('button', { name: '危険セラー除外を実行' }))

    await waitFor(() => expect(screen.queryByDisplayValue('eBay Title p1')).toBeNull())
  })

  it('「危険単語」ボタンも同様にパネルとして開閉する', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct('p1')],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ words: [] }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    await userEvent.click(screen.getByRole('button', { name: '危険単語を除外' }))
    expect(screen.getByText(/抽出危険設定に登録した危険単語/)).toBeInTheDocument()

    // 再度押すとパネルが閉じる(他の除外ボタンと同じトグル挙動)。
    await userEvent.click(screen.getByRole('button', { name: '危険単語を除外' }))
    expect(screen.queryByText(/抽出危険設定に登録した危険単語/)).not.toBeInTheDocument()
  })
})

describe('ProductEditPanel: 除外実行前の対象件数プレビュー', () => {
  it('Veroパネルを開くと、設定取得後に「全N件中M件が対象」と表示される', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeProduct('p1', { ebay_brand: 'Nintendo' }),
          makeProduct('p2', { ebay_brand: 'Generic' }),
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ vero: [{ brand: 'Nintendo' }] }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    // 設定取得が終わるまでは「確認中」を表示する。
    await userEvent.click(screen.getByRole('button', { name: 'Veroを除外' }))
    await waitFor(() => {
      const previewText = screen.getByText((_content, element) =>
        element?.tagName === 'P' && /全2件中\s*1件が対象です/.test(element.textContent ?? ''),
      )
      expect(previewText).toBeInTheDocument()
    })
  })

  it('評価数パネルは入力値を変更すると対象件数プレビューがリアルタイムで更新される', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { seller_rating_count: 3 }),
        makeProduct('p2', { seller_rating_count: 50 }),
        makeProduct('p3', { seller_rating_count: null }),
      ],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^除外$/ }))
    const ratingLabel = screen.getByText('評価数')
    const ratingRow = ratingLabel.closest('div') as HTMLElement
    await userEvent.click(within(ratingRow).getByRole('button'))

    function getPreviewText(): HTMLElement {
      return screen.getByText((_content, element) =>
        element?.tagName === 'P' && /全3件中\s*\d+件が対象です/.test(element.textContent ?? ''),
      )
    }

    // 未入力の初期状態では対象0件
    expect(getPreviewText().textContent).toMatch(/全3件中\s*0件が対象です/)

    await userEvent.type(screen.getByPlaceholderText('例: 10'), '5')
    await waitFor(() => expect(getPreviewText().textContent).toMatch(/全3件中\s*1件が対象です/))
  })
})

describe('ProductEditPanel: アイテムスペシフィック編集', () => {
  it('項目を一括適用してBulk APIへ保存する', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct('p1', {
          ebay_item_specifics: { Brand: ['Tamiya'] },
        })],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
      })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^編集$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'アイテムスペシフィックを編集' }))
    await userEvent.type(screen.getByRole('textbox', { name: '項目名' }), 'Material')
    await userEvent.type(screen.getByRole('textbox', { name: '項目値' }), 'Plastic, Metal')
    await userEvent.click(screen.getByRole('button', { name: '適用（1件）' }))
    await userEvent.click(screen.getByRole('button', { name: /編集保存/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body).toEqual({
      updates: [{
        productId: 'p1',
        ebay_item_specifics: {
          Brand: ['Tamiya'],
          Material: ['Plastic', 'Metal'],
        },
      }],
    })
  })
})

describe('ProductEditPanel: 商品検索', () => {
  it('キーワードに一致する商品のみを表示する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { original_title: 'Tamiya Mini 4WD' }),
        makeProduct('p2', { original_title: 'Nike Sneakers' }),
      ],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^検索$/ }))
    await userEvent.type(screen.getByRole('searchbox', { name: '商品検索キーワード' }), 'Tamiya')

    expect(screen.getByDisplayValue('eBay Title p1')).toBeTruthy()
    expect(screen.queryByDisplayValue('eBay Title p2')).toBeNull()
    expect(screen.getByText('1件', { selector: 'span' })).toBeTruthy()
  })

  it('複数条件を組み合わせ、リセットですべての商品へ戻す', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { source_site: 'mercari', ebay_condition: '中古', ebay_price: 40 }),
        makeProduct('p2', {
          source_site: 'snkrdunk',
          ebay_condition: '新品',
          ebay_price: null,
          price_type: 'auction',
        }),
      ],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^検索$/ }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '検索サイト' }), 'snkrdunk')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '検索商品状態' }), '新品')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '検索価格タイプ' }), 'auction')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'eBay価格設定状態' }), 'unset')

    expect(screen.queryByDisplayValue('eBay Title p1')).toBeNull()
    expect(screen.getByDisplayValue('eBay Title p2')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '条件をリセット' }))
    expect(screen.getByDisplayValue('eBay Title p1')).toBeTruthy()
    expect(screen.getByDisplayValue('eBay Title p2')).toBeTruthy()
  })

  it('検索結果が0件のとき専用メッセージを表示する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1')],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^検索$/ }))
    await userEvent.type(screen.getByRole('searchbox', { name: '商品検索キーワード' }), 'not-found')

    expect(screen.getByText('検索条件に一致する商品がありません')).toBeTruthy()
    expect(screen.getByText(/0-0 of 0/)).toBeTruthy()
  })
})

describe('ProductEditPanel: ポケモンカード専用設定', () => {
  it('ポケモン商品だけを表示して専用項目を一括保存する', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeProduct('p1', {
            original_title: 'ポケモンカード ピカチュウ',
            ebay_item_specifics: { Character: ['Pikachu'] },
          }),
          makeProduct('p2', { original_title: 'Tamiya Mini 4WD' }),
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
      })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^ポケモン$/ }))

    expect(screen.getByDisplayValue('eBay Title p1')).toBeTruthy()
    expect(screen.queryByDisplayValue('eBay Title p2')).toBeNull()
    expect(screen.getByText('1件', { selector: 'p' })).toBeTruthy()

    await userEvent.type(screen.getByRole('textbox', { name: 'ポケモンカード名' }), 'Pikachu')
    await userEvent.type(screen.getByRole('textbox', { name: 'ポケモンセット' }), 'Scarlet & Violet')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ポケモンカード鑑定' }), 'Yes')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ポケモンカード鑑定会社' }), 'PSA')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ポケモンカードグレード' }), '10')
    await userEvent.click(screen.getByRole('button', { name: 'ポケモン設定を適用（1件）' }))
    await userEvent.click(screen.getAllByRole('button', { name: /編集保存/ })[0])

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      updates: [{
        productId: 'p1',
        ebay_brand: 'Pokémon',
        ebay_item_specifics: {
          Character: ['Pikachu'],
          Game: ['Pokémon TCG'],
          Language: ['Japanese'],
          Graded: ['Yes'],
          'Card Name': ['Pikachu'],
          Set: ['Scarlet & Violet'],
          'Professional Grader': ['PSA'],
          Grade: ['10'],
        },
      }],
    })
  })

  it('対象商品がない場合は専用メッセージを表示して適用を無効にする', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { original_title: 'Tamiya Mini 4WD' })],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^ポケモン$/ }))

    expect(screen.getByText('この抽出にはポケモン商品が見つかりませんでした。')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ポケモン設定を適用（0件）' })).toBeDisabled()
    expect(screen.getByText('ポケモン商品がありません')).toBeTruthy()
  })
})

// ---------- テスト ----------

describe('ProductEditPanel: ebay_price 表示', () => {
  it('ebay_price が null の商品は価格入力欄が空欄', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      const input = screen.getByPlaceholderText('未設定') as HTMLInputElement
      expect(input.value).toBe('')
    })
  })

  it('ebay_price が null の商品は「未設定」ラベルが表示される', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('未設定')).toBeTruthy()
    })
  })

  it('ebay_price が数値の商品は入力欄にその値が表示される（$0 にならない）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      const input = screen.getByDisplayValue('30') as HTMLInputElement
      expect(input.value).toBe('30')
    })
  })
})

describe('ProductEditPanel: 価格入力バリデーション', () => {
  it('0を入力するとエラーが表示され、保存ボタンが無効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    const priceInput = screen.getByDisplayValue('30')
    await act(async () => {
      await userEvent.clear(priceInput)
      await userEvent.type(priceInput, '0')
    })

    expect(screen.getByText(/0より大きい値を入力してください/)).toBeTruthy()
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()
  })

  it('負数を入力するとエラーが表示され、保存ボタンが無効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    await act(async () => {
      await userEvent.clear(screen.getByDisplayValue('30'))
      await userEvent.type(screen.getByPlaceholderText('未設定'), '-5')
    })

    expect(screen.getByText(/0より大きい値を入力してください/)).toBeTruthy()
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()
  })

  it('エラーを修正すると保存ボタンが再び有効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    // 0を入力 → エラー
    const priceInput = screen.getByDisplayValue('30')
    await act(async () => {
      await userEvent.clear(priceInput)
      await userEvent.type(screen.getByPlaceholderText('未設定'), '0')
    })
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()

    // 正の値に修正 → 有効
    await act(async () => {
      await userEvent.clear(screen.getByPlaceholderText('未設定'))
      await userEvent.type(screen.getByPlaceholderText('未設定'), '29.99')
    })
    await waitFor(() => {
      expect(screen.queryByText(/0より大きい値を入力してください/)).toBeNull()
      expect(screen.getByText(/💾 編集保存/)).not.toBeDisabled()
    })
  })
})

describe('ProductEditPanel: saveAll の動作', () => {
  it('通信エラー後でも saving 状態が解除される（finally ブロック）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1')],
    })
    fetchMock.mockRejectedValueOnce(new Error('Network error'))

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getAllByDisplayValue(/eBay Title/))

    const titleInput = screen.getAllByDisplayValue(/eBay Title/)[0]
    await act(async () => {
      await userEvent.clear(titleInput)
      await userEvent.type(titleInput, 'New Title')
    })

    const saveBtn = screen.getByText(/💾 編集保存/)
    await act(async () => { await userEvent.click(saveBtn) })

    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled()
    })
    expect(screen.getByText(/通信エラー/)).toBeTruthy()
  })

  it('部分失敗: p1の表示は更新値、p2の入力は編集値を保持、再保存はp2のみ送信', async () => {
    // 初回ロード
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { ebay_title: 'Old Title 1' }),
        makeProduct('p2', { ebay_title: 'Old Title 2' }),
      ],
    })
    // 部分失敗レスポンス
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        ok: false,
        succeeded: ['p1'],
        failed: [{ productId: 'p2', error: '権限がありません' }],
      }),
    })
    // p2 のみの再保存
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p2'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => expect(screen.getAllByDisplayValue(/Old Title/)).toHaveLength(2))

    const [input1, input2] = screen.getAllByDisplayValue(/Old Title/) as HTMLInputElement[]
    await act(async () => {
      await userEvent.clear(input1)
      await userEvent.type(input1, 'New Title 1')
      await userEvent.clear(input2)
      await userEvent.type(input2, 'New Title 2')
    })

    await act(async () => { await userEvent.click(screen.getByText(/💾 編集保存/)) })

    await waitFor(() => {
      // p1 は成功 → products 状態が更新された値を表示
      expect(screen.getByDisplayValue('New Title 1')).toBeTruthy()
      // p2 は失敗 → edit が保持されて編集値を表示
      expect(screen.getByDisplayValue('New Title 2')).toBeTruthy()
      // エラーメッセージ表示
      expect(screen.getByText(/1件の保存に失敗/)).toBeTruthy()
    })

    // 再保存ボタンは有効（p2 のeditsが残っている）
    const saveBtn = screen.getByText(/💾 編集保存/)
    expect(saveBtn).not.toBeDisabled()

    // 再保存
    await act(async () => { await userEvent.click(saveBtn) })

    await waitFor(() => {
      // 3回目のfetch呼び出し（0=load, 1=first save, 2=second save）
      const calls = fetchMock.mock.calls
      expect(calls).toHaveLength(3)
      const secondSaveBody = JSON.parse(calls[2][1].body as string)
      // p2 だけが送信される
      expect(secondSaveBody.updates).toHaveLength(1)
      expect(secondSaveBody.updates[0].productId).toBe('p2')
    })
  })
})

describe('ProductEditPanel: 編集タブの保存操作', () => {
  it('編集タブでも保存ボタンが表示され、編集後に有効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '編集' }))
    })

    const saveBtn = screen.getByText(/💾 編集保存/)
    expect(saveBtn).toBeDisabled()

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('未設定'), '83')
    })

    expect(saveBtn).not.toBeDisabled()
  })
})

describe('ProductEditPanel: ブランド編集', () => {
  it('商品ごとのブランド変更を保存APIへ送る', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_brand: 'PILOT' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('PILOT'))
    const brandInput = screen.getByDisplayValue('PILOT')
    await act(async () => {
      await userEvent.clear(brandInput)
      await userEvent.type(brandInput, 'SAILOR')
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_brand: 'SAILOR' }])
  })

  it('ブランド入力を空にするとnullを保存する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_brand: 'PILOT' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('PILOT'))
    await act(async () => {
      await userEvent.clear(screen.getByDisplayValue('PILOT'))
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_brand: null }])
  })

  it('一括編集で同じブランドを現在ページへ適用する', async () => {
    const { default: BrandEditModal } = await import('../components/extraction/BrandEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <BrandEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getBrand={() => ''}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('例: PILOT'), '  PILOT  ')
      await userEvent.click(screen.getByRole('button', { name: /適用 \(1件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith('PILOT', 'page')
  })

  it('一括編集でブランドを全商品からクリアする', async () => {
    const { default: BrandEditModal } = await import('../components/extraction/BrandEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <BrandEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getBrand={() => 'PILOT'}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText('ブランドをクリア'))
      await userEvent.click(screen.getByLabelText('抽出商品すべて'))
      await userEvent.click(screen.getByRole('button', { name: /適用 \(2件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(null, 'all')
  })
})

describe('ProductEditPanel: 商品詳細編集', () => {
  it('詳細編集モードで商品ごとの商品詳細を保存APIへ送る', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_description: 'Old description' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('簡易編集モード'))
    await act(async () => {
      await userEvent.selectOptions(screen.getByDisplayValue('簡易編集モード'), '詳細編集モード')
    })
    const description = await screen.findByDisplayValue('Old description')
    await act(async () => {
      await userEvent.clear(description)
      await userEvent.type(description, 'New description')
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_description: 'New description' }])
  })

  it('一括編集で同じ商品詳細を現在ページへ適用する', async () => {
    const { default: DescriptionEditModal } = await import('../components/extraction/DescriptionEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <DescriptionEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getDescription={() => ''}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('商品詳細を入力'), 'Description')
      await userEvent.click(screen.getByRole('button', { name: /適用 \(1件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'set', value: 'Description' }), 'page')
  })

  it('一括編集で全商品の商品詳細をクリアする', async () => {
    const { default: DescriptionEditModal } = await import('../components/extraction/DescriptionEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <DescriptionEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getDescription={() => 'Description'}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText('商品詳細をクリア'))
      await userEvent.click(screen.getByLabelText('抽出商品すべて'))
      await userEvent.click(screen.getByRole('button', { name: /適用 \(2件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'clear' }), 'all')
  })
})

describe('ProductEditPanel: 画像枚数編集', () => {
  const images = Array.from({ length: 5 }, (_, index) => `https://example.com/${index + 1}.jpg`)

  it('画像枚数モーダルで現在ページに指定枚数を適用する', async () => {
    const { default: ImageCountEditModal } = await import('../components/extraction/ImageCountEditModal')
    const products = [
      makeProduct('p1', { ebay_images: images }),
      makeProduct('p2', { ebay_images: images }),
    ]
    const onApply = vi.fn()

    render(
      <ImageCountEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getImages={(product) => product.ebay_images}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    const countInput = screen.getByRole('spinbutton', { name: '残す画像枚数' })
    await act(async () => {
      await userEvent.clear(countInput)
      await userEvent.type(countInput, '3')
      await userEvent.click(screen.getByRole('button', { name: /適用（変更 1件）/ }))
    })

    expect(onApply).toHaveBeenCalledWith(3, 'page')
  })

  it('画像を先頭2枚に絞って保存APIへ送る', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_images: images, original_images: images })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '編集' }))
      await userEvent.click(screen.getByRole('button', { name: '画像枚数以降を編集' }))
    })

    const countInput = screen.getByRole('spinbutton', { name: '残す画像枚数' })
    await act(async () => {
      await userEvent.clear(countInput)
      await userEvent.type(countInput, '2')
      await userEvent.click(screen.getByRole('button', { name: /適用（変更 1件）/ }))
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_images: images.slice(0, 2) }])
  })

  it('変更対象がない場合は適用ボタンを無効化する', async () => {
    const { default: ImageCountEditModal } = await import('../components/extraction/ImageCountEditModal')
    const products = [makeProduct('p1', { ebay_images: images.slice(0, 2) })]

    render(
      <ImageCountEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getImages={(product) => product.ebay_images}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /適用（変更 0件）/ })).toBeDisabled()
  })
})

describe('PriceEditModal: 仕入価格未設定の処理', () => {
  it('倍率モードで仕入価格未設定商品があれば適用ボタンが無効', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rate: 163.64, date: '2026-07-25' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [makeProduct('p1', { purchase_price_jpy: null, original_price: null })]
    const pagedIds = new Set(['p1'])

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/仕入 × 倍率/))
    })

    const rateInput = screen.getByPlaceholderText('例: 0.08')
    await act(async () => { await userEvent.type(rateInput, '0.1') })

    expect(screen.getByText(/仕入価格未設定/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /適用/ })).toBeDisabled()
  })

  it('固定価格モードは仕入価格不要で適用できる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rate: 163.64, date: '2026-07-25' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [makeProduct('p1', { purchase_price_jpy: null, original_price: null })]
    const pagedIds = new Set(['p1'])

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/固定ドル価格/))
    })

    const priceInput = screen.getByPlaceholderText('例: 49.99')
    await act(async () => { await userEvent.type(priceInput, '29.99') })

    expect(screen.getByRole('button', { name: /適用/ })).not.toBeDisabled()
  })
})

describe('PriceEditModal: 自動為替と価格帯別利益額', () => {
  it('最新のUSD/JPYを自動取得し、手動調整もできる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rate: 163.64, date: '2026-07-25' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const product = makeProduct('p1', { purchase_price_jpy: 6000 })

    render(
      <PriceEditModal
        products={[product]}
        pagedIds={new Set(['p1'])}
        getPurchaseJpy={() => 6000}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const exchangeInput = await screen.findByRole('spinbutton', { name: '1ドルあたりの円レート' })
    await waitFor(() => expect(exchangeInput).toHaveValue(163.64))
    expect(screen.getByText(/2026-07-25時点の最新レートを自動取得/)).toBeTruthy()

    await userEvent.clear(exchangeInput)
    await userEvent.type(exchangeInput, '160')
    expect(exchangeInput).toHaveValue(160)
    expect(screen.getByText(/取得値から手動調整中/)).toBeTruthy()
  })

  it('価格帯に対応する利益額で販売価格を計算して適用する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rate: 150, date: '2026-07-25' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const product = makeProduct('p1', { purchase_price_jpy: 6000 })
    const onApply = vi.fn()

    render(
      <PriceEditModal
        products={[product]}
        pagedIds={new Set(['p1'])}
        getPurchaseJpy={() => 6000}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByLabelText('価格帯別利益額'))
    await waitFor(() => expect(screen.getByText(/目標 ¥3,000/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /適用/ }))

    expect(onApply).toHaveBeenCalledTimes(1)
    const getPrice = onApply.mock.calls[0][0] as (target: typeof product) => number | null
    expect(getPrice(product)).toBe(87)
  })

  it('各価格帯の下へ行を追加して、利益設定を細分化できる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rate: 150, date: '2026-07-25' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const product = makeProduct('p1', { purchase_price_jpy: 14500 })

    render(
      <PriceEditModal
        products={[product]}
        pagedIds={new Set(['p1'])}
        getPurchaseJpy={() => 14500}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByLabelText('価格帯別利益額'))
    await userEvent.click(screen.getByRole('button', { name: '価格帯2の下に行を追加' }))

    expect(screen.getByRole('spinbutton', { name: '仕入上限 3' })).toHaveValue(null)
    expect(screen.getByRole('spinbutton', { name: '希望利益額 3' })).toHaveValue(null)
    expect(screen.getByRole('spinbutton', { name: '仕入上限 4' })).toHaveValue(20000)

    await userEvent.type(screen.getByRole('spinbutton', { name: '仕入上限 3' }), '15000')
    await userEvent.type(screen.getByRole('spinbutton', { name: '希望利益額 3' }), '4000')

    expect(screen.getByText(/目標 ¥4,000/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '価格帯3を削除' }))
    expect(screen.queryByText(/目標 ¥4,000/)).toBeNull()
    expect(screen.getByRole('spinbutton', { name: '仕入上限 3' })).toHaveValue(20000)
  })

  it('為替取得に失敗しても手動入力用の初期値を維持する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'failed' }),
    })
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const product = makeProduct('p1', { purchase_price_jpy: 6000 })

    render(
      <PriceEditModal
        products={[product]}
        pagedIds={new Set(['p1'])}
        getPurchaseJpy={() => 6000}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByText(/自動取得できませんでした/)).toBeTruthy()
    })
    expect(screen.getByRole('spinbutton', { name: '1ドルあたりの円レート' })).toHaveValue(150)
  })
})
