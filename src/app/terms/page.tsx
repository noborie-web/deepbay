import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '利用規約 | DeepBay',
  description: 'DeepBayの利用規約',
}

const sections = [
  {
    title: '1. 総則',
    body: '本規約は、DeepBayが提供するサービスの利用条件を定めるものです。利用者は、本規約に同意したうえで本サービスを利用するものとします。',
  },
  {
    title: '2. サービス内容',
    body: '本サービスは、商品情報の抽出・編集、eBayへの出品支援、在庫管理その他これらに関連する機能を提供します。提供する機能や仕様は、事前の通知なく変更または終了する場合があります。',
  },
  {
    title: '3. 禁止事項',
    body: '利用者は、法令またはeBayその他の外部サービスの規約に違反する行為、VeRO対象商品や権利侵害品の出品、不正アクセス、本サービスの運営を妨げる行為、第三者になりすます行為、その他DeepBayが不適切と判断する行為をしてはなりません。',
  },
  {
    title: '4. アカウントの停止・利用制限',
    body: '利用者が本規約に違反した場合、またはサービスの安全な運営に支障があると判断した場合、DeepBayは事前の通知なくアカウントの停止、機能の制限、または利用契約の解除を行うことがあります。',
  },
  {
    title: '5. 免責事項',
    body: 'DeepBayは、本サービスの完全性、正確性、継続性、特定目的への適合性を保証しません。本サービスの利用により生じた損害について、法令上認められる範囲で責任を負いません。利用者は出品内容や取引条件を自ら確認し、その責任において本サービスを利用するものとします。',
  },
  {
    title: '6. eBay等外部サービスとの関係',
    body: '本サービスはeBayその他の外部サービスと連携しますが、それらのサービスを運営するものではありません。外部サービスの規約変更、仕様変更、障害、停止またはアカウント制限等により生じた損害について、DeepBayは責任を負いません。',
  },
  {
    title: '7. 規約の変更',
    body: 'DeepBayは、法令やサービス内容の変更等に応じて本規約を改定することがあります。重要な変更はサービス上でお知らせし、変更後の規約は掲示した時点または別途定める時点から効力を生じます。',
  },
]

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gray-50 px-5 py-12 text-gray-900">
      <article className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
        <h1 className="text-3xl font-bold">利用規約</h1>
        <p className="mt-3 text-sm text-gray-500">最終更新日: 2026年8月23日</p>
        <p className="mt-8 leading-7 text-gray-700">
          DeepBayを安心してご利用いただくため、以下のとおり利用規約を定めます。
        </p>

        <div className="mt-10 space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-xl font-semibold">{section.title}</h2>
              <p className="mt-3 leading-7 text-gray-700">{section.body}</p>
            </section>
          ))}
        </div>
      </article>
    </main>
  )
}
