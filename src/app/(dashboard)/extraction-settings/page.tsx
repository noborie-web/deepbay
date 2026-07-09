'use client'

import { useState, useEffect, useRef } from 'react'

type Engine = 'normal' | 'high' | 'best'
type Tab = 'basic' | 'danger' | 'html'

interface ExtractionSettings {
  title_engine: Engine; title_enabled: boolean
  brand_engine: Engine; brand_enabled: boolean
  description_engine: Engine; description_enabled: boolean
  exclude_active_duplicate: boolean
  exclude_title_duplicate: boolean
  exclude_translated_duplicate: boolean
}

interface DangerSeller { id: string; seller_url: string }
interface DangerWord { id: string; word: string }
interface ReplaceWord { id: string; before_word: string; after_word: string }
interface HtmlTemplate { id: string; name: string; content: string; is_active: boolean }
interface VeroBrand { id: string; brand: string }

const ENGINE_LABELS: Record<Engine, string> = { normal: '通常品質', high: '高品質翻訳', best: '最高品質翻訳' }
const DEFAULT_SETTINGS: ExtractionSettings = {
  title_engine: 'high', title_enabled: true,
  brand_engine: 'high', brand_enabled: true,
  description_engine: 'high', description_enabled: true,
  exclude_active_duplicate: true,
  exclude_title_duplicate: false,
  exclude_translated_duplicate: false,
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative inline-flex w-11 h-6 rounded-full transition-colors ${value ? 'bg-blue-500' : 'bg-gray-300'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

function ListSection({
  title, inputPlaceholder, items, onAdd, onDelete, onClear, onCsvDownload, onCsvUpload,
  inputExtra, itemLabel,
}: {
  title: string
  inputPlaceholder: string
  items: { id: string; label: string; sub?: string }[]
  onAdd: (val: string, val2?: string) => void
  onDelete: (id: string) => void
  onClear: () => void
  onCsvDownload: () => void
  onCsvUpload: (rows: string[][]) => void
  inputExtra?: string
  itemLabel?: string
}) {
  const [val, setVal] = useState('')
  const [val2, setVal2] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const lines = text.split(/\r?\n/)
      const allRows: string[][] = []
      for (const line of lines.slice(1)) {
        // strip outer quotes
        const stripped = line.replace(/^"|"$/g, '').trim()
        if (!stripped) continue
        // handle cells that contain multiple entries separated by \r\n or literal \r\n
        const subLines = stripped.split(/\\r\\n|\r\n|\n/)
        for (const sub of subLines) {
          const cleaned = sub.replace(/\\\\n|\\n/g, '').replace(/^\\?"|\\?"$/g, '').trim()
          if (!cleaned) continue
          const cols = cleaned.split(',').map((v) => v.replace(/^"|"$/g, '').trim())
          if (cols[0]) allRows.push(cols)
        }
      }
      onCsvUpload(allRows)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div className="mb-8">
      <p className="text-sm font-medium text-gray-700 mb-3">{title}</p>
      <div className="flex gap-4">
        {/* 左: 入力フォーム */}
        <div className="w-64 shrink-0">
          <div className="flex gap-2 mb-2">
            <input
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) { onAdd(val.trim(), val2.trim()); setVal(''); setVal2('') } }}
              placeholder={inputPlaceholder}
              className="flex-1 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
            {inputExtra && (
              <input
                value={val2}
                onChange={(e) => setVal2(e.target.value)}
                placeholder={inputExtra}
                className="flex-1 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            )}
            <button
              onClick={() => { if (val.trim()) { onAdd(val.trim(), val2.trim()); setVal(''); setVal2('') } }}
              className="border border-green-500 text-green-600 rounded px-3 py-1.5 text-xs hover:bg-green-50"
            >
              追加
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => fileRef.current?.click()}
              className="border border-green-500 text-green-600 rounded px-3 py-1 text-xs hover:bg-green-50"
            >
              CSVアップロード
            </button>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
            <button
              onClick={onCsvDownload}
              className="border border-green-500 text-green-600 rounded px-3 py-1 text-xs hover:bg-green-50"
            >
              CSVダウンロード
            </button>
            <button
              onClick={onClear}
              className="border border-red-400 text-red-500 rounded px-3 py-1 text-xs hover:bg-red-50"
            >
              クリア
            </button>
          </div>
        </div>

        {/* 右: 登録リスト */}
        <div className="flex-1 border rounded flex flex-col">
          <div className={`grid ${inputExtra ? 'grid-cols-[1fr_1fr_60px]' : 'grid-cols-[1fr_60px]'} px-3 py-2 bg-gray-50 border-b text-xs text-gray-500 font-medium shrink-0`}>
            <span>{itemLabel ?? '登録済み'}</span>
            {inputExtra && <span>置換後</span>}
            <span className="text-right">削除</span>
          </div>
          <div className="overflow-y-auto max-h-48">
            {items.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">未登録</div>
            ) : (
              items.map((item) => (
                <div key={item.id} className={`grid ${inputExtra ? 'grid-cols-[1fr_1fr_60px]' : 'grid-cols-[1fr_60px]'} px-3 py-2 border-b last:border-0 items-center`}>
                  <span className="text-gray-700 text-xs truncate">{item.label}</span>
                  {inputExtra && <span className="text-gray-500 text-xs truncate">{item.sub}</span>}
                  <div className="flex justify-end">
                    <button
                      onClick={() => onDelete(item.id)}
                      className="border border-red-400 text-red-500 rounded px-2 py-0.5 text-xs hover:bg-red-50"
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ExtractionSettingsPage() {
  const [tab, setTab] = useState<Tab>('basic')
  const [settings, setSettings] = useState<ExtractionSettings>(DEFAULT_SETTINGS)
  const [sellers, setSellers] = useState<DangerSeller[]>([])
  const [words, setWords] = useState<DangerWord[]>([])
  const [replaces, setReplaces] = useState<ReplaceWord[]>([])
  const [templates, setTemplates] = useState<HtmlTemplate[]>([])
  const [vero, setVero] = useState<VeroBrand[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [newTemplateName, setNewTemplateName] = useState('')
  const [editingTemplate, setEditingTemplate] = useState<HtmlTemplate | null>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const [activeTemplateId, setActiveTemplateId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetch('/api/extraction-settings')
      .then((r) => r.json())
      .then((data) => {
        if (data.settings) setSettings({ ...DEFAULT_SETTINGS, ...data.settings })
        setSellers(data.sellers ?? [])
        setWords(data.words ?? [])
        setReplaces(data.replaces ?? [])
        setTemplates(data.templates ?? [])
        setVero(data.vero ?? [])
        if (data.settings?.html_template_id) setActiveTemplateId(data.settings.html_template_id)
        setLoading(false)
      })
  }, [])

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  async function saveBasicSettings() {
    setSaving(true)
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'settings', ...settings }),
    })
    setSaving(false)
    if (res.ok) flash('設定を保存しました')
  }

  async function addSeller(url: string) {
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'seller', seller_url: url }),
    })
    if (res.ok) {
      const data = await fetch('/api/extraction-settings').then((r) => r.json())
      setSellers(data.sellers ?? [])
    }
  }

  async function deleteSeller(id: string) {
    await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'seller', id }) })
    setSellers((prev) => prev.filter((s) => s.id !== id))
  }

  async function clearSellers() {
    if (!confirm('危険セラーをすべて削除しますか？')) return
    for (const s of sellers) await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'seller', id: s.id }) })
    setSellers([])
  }

  async function addWord(word: string) {
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'word', word }),
    })
    if (res.ok) {
      const data = await fetch('/api/extraction-settings').then((r) => r.json())
      setWords(data.words ?? [])
    }
  }

  async function deleteWord(id: string) {
    await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'word', id }) })
    setWords((prev) => prev.filter((w) => w.id !== id))
  }

  async function clearWords() {
    if (!confirm('危険単語をすべて削除しますか？')) return
    for (const w of words) await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'word', id: w.id }) })
    setWords([])
  }

  async function addReplace(before: string, after: string) {
    if (!before || !after) return
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'replace', before_word: before, after_word: after }),
    })
    if (res.ok) {
      const data = await fetch('/api/extraction-settings').then((r) => r.json())
      setReplaces(data.replaces ?? [])
    }
  }

  async function deleteReplace(id: string) {
    await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'replace', id }) })
    setReplaces((prev) => prev.filter((r) => r.id !== id))
  }

  async function uploadSellersCsv(rows: string[][]) {
    const urls = rows.map((r) => r[0]).filter(Boolean)
    if (!urls.length) return
    await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'seller', seller_urls: urls }),
    })
    const data = await fetch('/api/extraction-settings').then((r) => r.json())
    setSellers(data.sellers ?? [])
    flash(`${urls.length}件のセラーを追加しました`)
  }

  async function uploadWordsCsv(rows: string[][]) {
    const wordList = rows.map((r) => r[0]).filter(Boolean)
    if (!wordList.length) return
    await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'word', words: wordList }),
    })
    const data = await fetch('/api/extraction-settings').then((r) => r.json())
    setWords(data.words ?? [])
    flash(`${wordList.length}件の単語を追加しました`)
  }

  async function uploadReplacesCsv(rows: string[][]) {
    const pairs = rows.map((r) => ({ before: r[0], after: r[1] ?? '' })).filter((p) => p.before)
    if (!pairs.length) return
    await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'replace', pairs }),
    })
    const data = await fetch('/api/extraction-settings').then((r) => r.json())
    setReplaces(data.replaces ?? [])
    flash(`${pairs.length}件の置換単語を追加しました`)
  }

  async function clearReplaces() {
    if (!confirm('置換単語をすべて削除しますか？')) return
    for (const r of replaces) await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'replace', id: r.id }) })
    setReplaces([])
  }

  async function addVero(brand: string) {
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'vero', brand }),
    })
    if (res.ok) {
      const data = await fetch('/api/extraction-settings').then((r) => r.json())
      setVero(data.vero ?? [])
    }
  }

  async function deleteVero(id: string) {
    await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'vero', id }) })
    setVero((prev) => prev.filter((v) => v.id !== id))
  }

  async function clearVero() {
    if (!confirm('Veroブランドをすべて削除しますか？')) return
    for (const v of vero) await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'vero', id: v.id }) })
    setVero([])
  }

  async function uploadVeroCsv(rows: string[][]) {
    const brands = rows.map((r) => r[0]).filter(Boolean)
    if (!brands.length) return
    await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'vero', brands }),
    })
    const data = await fetch('/api/extraction-settings').then((r) => r.json())
    setVero(data.vero ?? [])
    flash(`${brands.length}件のVeroブランドを追加しました`)
  }

  async function createTemplate() {
    const name = newTemplateName.trim() || `テンプレート${templates.length + 1}`
    const res = await fetch('/api/extraction-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'template', name }),
    })
    if (res.ok) {
      const data = await fetch('/api/extraction-settings').then((r) => r.json())
      setTemplates(data.templates ?? [])
      setNewTemplateName('')
      flash(`「${name}」を作成しました`)
    }
  }

  function downloadCsv(header: string, rows: string[], filename: string) {
    const lines = [header, ...rows.map((r) => `"${r.replace(/"/g, '""')}"`)]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  function downloadReplaceCsv(rows: { before_word: string; after_word: string }[], filename: string) {
    const lines = ['before,after', ...rows.map((r) => `"${r.before_word.replace(/"/g, '""')}","${r.after_word.replace(/"/g, '""')}"`)]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">読み込み中...</div>

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-bold mb-6">抽出設定</h1>

      {msg && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
          {msg}
        </div>
      )}

      {/* タブ */}
      <div className="flex gap-6 border-b mb-6">
        {([['basic', '抽出基本設定'], ['danger', '抽出危険設定'], ['html', 'HTML設定']] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === key ? 'border-gray-800 text-gray-800' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 抽出基本設定 */}
      {tab === 'basic' && (
        <div className="space-y-8">
          <button
            onClick={saveBasicSettings}
            disabled={saving}
            className="border border-green-500 text-green-600 rounded px-4 py-1.5 text-sm hover:bg-green-50 disabled:opacity-50"
          >
            設定保存
          </button>

          {/* 翻訳設定 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-4 pb-1 border-b">翻訳設定</h2>
            <div className="space-y-4">
              {([
                ['タイトル設定', 'title_engine', 'title_enabled'],
                ['ブランド設定', 'brand_engine', 'brand_enabled'],
                ['商品詳細設定', 'description_engine', 'description_enabled'],
              ] as [string, keyof ExtractionSettings, keyof ExtractionSettings][]).map(([label, engineKey, enabledKey]) => (
                <div key={label}>
                  <p className="text-sm text-gray-600 mb-2">{label}</p>
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <label className="absolute -top-2 left-3 text-xs text-gray-400 bg-white px-1">翻訳エンジン</label>
                      <select
                        value={settings[engineKey] as string}
                        onChange={(e) => setSettings((prev) => ({ ...prev, [engineKey]: e.target.value }))}
                        className="border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 w-52"
                      >
                        {Object.entries(ENGINE_LABELS).map(([val, lbl]) => (
                          <option key={val} value={val}>{lbl}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Toggle
                        value={settings[enabledKey] as boolean}
                        onChange={(v) => setSettings((prev) => ({ ...prev, [enabledKey]: v }))}
                      />
                      <span className="text-xs text-gray-500">{settings[enabledKey] ? '有効中' : '無効'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 依頼時の除外設定 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-4 pb-1 border-b">依頼時の次の除外設定</h2>
            <div className="flex flex-wrap gap-6">
              {([
                ['exclude_active_duplicate', 'active重複: 除外', 'active重複: 除外しない'],
                ['exclude_title_duplicate', 'タイトル重複: 除外', 'タイトル重複: 除外しない'],
                ['exclude_translated_duplicate', '翻訳後タイトル重複: 除外', '翻訳後タイトル重複: 除外しない'],
              ] as [keyof ExtractionSettings, string, string][]).map(([key, onLabel, offLabel]) => (
                <div key={key} className="flex items-center gap-2">
                  <Toggle
                    value={settings[key] as boolean}
                    onChange={(v) => setSettings((prev) => ({ ...prev, [key]: v }))}
                  />
                  <span className="text-sm text-gray-600">{settings[key] ? onLabel : offLabel}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 抽出危険設定 */}
      {tab === 'danger' && (
        <div className="space-y-2">
          <ListSection
            title="危険セラー"
            inputPlaceholder="除外セラーurl"
            items={sellers.map((s) => ({ id: s.id, label: s.seller_url }))}
            onAdd={(url) => addSeller(url)}
            onDelete={deleteSeller}
            onClear={clearSellers}
            onCsvDownload={() => downloadCsv('sellers', sellers.map((s) => s.seller_url), 'danger_sellers.csv')}
            onCsvUpload={uploadSellersCsv}
            itemLabel="登録セラー"
          />
          <ListSection
            title="危険単語"
            inputPlaceholder="除外単語"
            items={words.map((w) => ({ id: w.id, label: w.word }))}
            onAdd={(word) => addWord(word)}
            onDelete={deleteWord}
            onClear={clearWords}
            onCsvDownload={() => downloadCsv('words', words.map((w) => w.word), 'danger_words.csv')}
            onCsvUpload={uploadWordsCsv}
            itemLabel="登録単語"
          />
          <ListSection
            title="置換単語"
            inputPlaceholder="置換前"
            inputExtra="置換後"
            items={replaces.map((r) => ({ id: r.id, label: r.before_word, sub: r.after_word }))}
            onAdd={(before, after) => addReplace(before, after ?? '')}
            onDelete={deleteReplace}
            onClear={clearReplaces}
            onCsvDownload={() => downloadReplaceCsv(replaces, 'replace_words.csv')}
            onCsvUpload={uploadReplacesCsv}
            itemLabel="置換前"
          />
          <ListSection
            title="Veroブランド"
            inputPlaceholder="ブランド名"
            items={vero.map((v) => ({ id: v.id, label: v.brand }))}
            onAdd={(brand) => addVero(brand)}
            onDelete={deleteVero}
            onClear={clearVero}
            onCsvDownload={() => downloadCsv('brand', vero.map((v) => v.brand), 'vero_brands.csv')}
            onCsvUpload={uploadVeroCsv}
            itemLabel="登録ブランド"
          />
        </div>
      )}

      {/* HTML設定 */}
      {tab === 'html' && (
        <div className="space-y-4">
          {/* 新規作成 */}
          <div className="flex items-center gap-3">
            <input
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              placeholder="テンプレート名（省略可）"
              className="border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 w-56"
            />
            <button onClick={createTemplate} className="border border-green-500 text-green-600 rounded px-4 py-1.5 text-sm hover:bg-green-50">
              新規作成
            </button>
          </div>

          {/* テンプレート選択 */}
          <div className="flex items-center gap-3">
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value)
                const t = templates.find((t) => t.id === e.target.value)
                setEditingTemplate(t ?? null)
                setPreviewMode(false)
              }}
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
            >
              <option value="">HTMLディスクリプション選択</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.id === activeTemplateId ? ' ★アクティブ' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* 変数チップ */}
          {editingTemplate && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">クリックでカーソル位置に挿入：</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  ['{{title}}', '英語タイトル'],
                  ['{{original_title}}', '日本語タイトル'],
                  ['{{description}}', '商品説明'],
                  ['{{condition}}', '商品状態'],
                  ['{{price}}', '価格'],
                  ['{{images}}', '全画像'],
                  ['{{image1}}', '画像1'],
                  ['{{image2}}', '画像2'],
                  ['{{image3}}', '画像3'],
                ].map(([tag, label]) => (
                  <button
                    key={tag}
                    onClick={() => {
                      const ta = document.getElementById('html-editor') as HTMLTextAreaElement
                      if (!ta) return
                      const start = ta.selectionStart
                      const end = ta.selectionEnd
                      const newContent = editingTemplate.content.slice(0, start) + tag + editingTemplate.content.slice(end)
                      setEditingTemplate((prev) => prev ? { ...prev, content: newContent } : null)
                      setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + tag.length; ta.focus() }, 0)
                    }}
                    className="border border-blue-300 text-blue-600 rounded px-2 py-0.5 text-xs hover:bg-blue-50"
                    title={label}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* テンプレート編集・プレビュー */}
          {editingTemplate && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex border rounded overflow-hidden text-xs">
                  <button
                    onClick={() => setPreviewMode(false)}
                    className={`px-3 py-1.5 ${!previewMode ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  >
                    編集
                  </button>
                  <button
                    onClick={() => setPreviewMode(true)}
                    className={`px-3 py-1.5 ${previewMode ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  >
                    プレビュー
                  </button>
                </div>
                <span className="text-xs text-gray-400">※プレビューはサンプルデータで表示</span>
              </div>

              {!previewMode ? (
                <textarea
                  id="html-editor"
                  value={editingTemplate.content}
                  onChange={(e) => setEditingTemplate((prev) => prev ? { ...prev, content: e.target.value } : null)}
                  rows={18}
                  placeholder={`例:\n<div style="font-family:Arial,sans-serif">\n  <h2>{{title}}</h2>\n  <p>{{description}}</p>\n  {{images}}\n</div>`}
                  className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
              ) : (
                <div
                  className="w-full border rounded p-4 min-h-64 overflow-auto bg-white text-sm"
                  dangerouslySetInnerHTML={{
                    __html: editingTemplate.content
                      .replace(/\{\{title\}\}/g, 'Vintage Camera Nikon F3 35mm Film SLR Body Japan')
                      .replace(/\{\{original_title\}\}/g, 'ニコン F3 フィルムカメラ ボディ 動作確認済み')
                      .replace(/\{\{description\}\}/g, '状態良好。動作確認済みです。細かいキズあり。')
                      .replace(/\{\{condition\}\}/g, 'Used - Good')
                      .replace(/\{\{price\}\}/g, '¥12,000')
                      .replace(/\{\{images\}\}/g, '<img src="https://placehold.co/400x300?text=Image1" style="max-width:100%;margin:4px"><img src="https://placehold.co/400x300?text=Image2" style="max-width:100%;margin:4px">')
                      .replace(/\{\{image1\}\}/g, 'https://placehold.co/400x300?text=Image1')
                      .replace(/\{\{image2\}\}/g, 'https://placehold.co/400x300?text=Image2')
                      .replace(/\{\{image3\}\}/g, 'https://placehold.co/400x300?text=Image3'),
                  }}
                />
              )}

              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={async () => {
                    if (!editingTemplate) return
                    await fetch('/api/extraction-settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'template_update', id: editingTemplate.id, content: editingTemplate.content }),
                    })
                    setTemplates((prev) => prev.map((t) => t.id === editingTemplate.id ? { ...t, content: editingTemplate.content } : t))
                    flash('保存しました')
                  }}
                  className="border border-green-500 text-green-600 rounded px-4 py-1.5 text-sm hover:bg-green-50"
                >
                  保存
                </button>
                <button
                  onClick={async () => {
                    await fetch('/api/extraction-settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'settings', html_template_id: editingTemplate.id }),
                    })
                    setActiveTemplateId(editingTemplate.id)
                    flash(`「${editingTemplate.name}」をアクティブに設定しました`)
                  }}
                  className={`border rounded px-4 py-1.5 text-sm ${
                    activeTemplateId === editingTemplate.id
                      ? 'border-yellow-400 text-yellow-600 bg-yellow-50'
                      : 'border-gray-400 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {activeTemplateId === editingTemplate.id ? '★ アクティブ中' : 'アクティブに設定'}
                </button>
                <button
                  onClick={async () => {
                    if (!confirm('このテンプレートを削除しますか？')) return
                    await fetch('/api/extraction-settings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'template', id: editingTemplate.id }) })
                    setTemplates((prev) => prev.filter((t) => t.id !== editingTemplate.id))
                    if (activeTemplateId === editingTemplate.id) setActiveTemplateId('')
                    setEditingTemplate(null)
                    setSelectedTemplateId('')
                    flash('削除しました')
                  }}
                  className="border border-red-400 text-red-500 rounded px-4 py-1.5 text-sm hover:bg-red-50"
                >
                  削除
                </button>
              </div>
            </div>
          )}

          {templates.length === 0 && (
            <p className="text-sm text-gray-400 mt-4">テンプレートがありません。上の「新規作成」から作成してください。</p>
          )}
        </div>
      )}
    </div>
  )
}
