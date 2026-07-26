import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'プライバシーポリシー | DeepBay',
  description: 'DeepBayのプライバシーポリシー',
}

const sections = [
  {
    title: '1. 取得する情報',
    body: 'DeepBayは、サービスの提供に必要な範囲で、ログイン情報、出品者アカウント情報、商品・出品情報、サービスの利用履歴、および外部サービスとの連携に必要な認証情報を取得します。',
  },
  {
    title: '2. 利用目的',
    body: '取得した情報は、商品の抽出・編集・出品、在庫管理、eBayアカウントおよび出品ポリシーとの連携、本人確認、障害対応、不正利用の防止、ならびにサービス品質の改善に利用します。',
  },
  {
    title: '3. eBay連携情報',
    body: 'eBayとの連携で取得した認証情報は暗号化して保存し、利用者が許可した機能を提供する目的にのみ使用します。DeepBayがeBayのパスワードを取得または保存することはありません。',
  },
  {
    title: '4. 第三者提供',
    body: '法令に基づく場合を除き、本人の同意なく個人情報を第三者へ提供しません。ただし、サービス提供に必要なクラウド、データベース、決済、外部APIなどの委託先には、必要最小限の情報を取り扱わせる場合があります。',
  },
  {
    title: '5. 安全管理',
    body: '取得した情報への不正アクセス、漏えい、滅失または毀損を防ぐため、アクセス制御、暗号化その他の合理的な安全管理措置を講じます。',
  },
  {
    title: '6. 情報の確認・削除',
    body: '利用者は、DeepBayに保存された自身の情報について、確認、訂正、連携解除または削除を求めることができます。サービス内の運営者への連絡手段からお申し出ください。',
  },
  {
    title: '7. ポリシーの変更',
    body: '法令やサービス内容の変更に応じて本ポリシーを改定する場合があります。重要な変更はサービス上でお知らせします。',
  },
]

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gray-50 px-5 py-12 text-gray-900">
      <article className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
        <h1 className="text-3xl font-bold">プライバシーポリシー</h1>
        <p className="mt-3 text-sm text-gray-500">最終更新日: 2026年7月26日</p>
        <p className="mt-8 leading-7 text-gray-700">
          DeepBayは、利用者の情報を適切に取り扱い、安全に管理するため、以下のとおりプライバシーポリシーを定めます。
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
