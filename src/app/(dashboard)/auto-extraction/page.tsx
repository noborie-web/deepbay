import { RefreshCw } from 'lucide-react'

export default function AutoExtractionPage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900">自動抽出</h1>
      <div className="mt-6 max-w-3xl rounded-lg border border-gray-200 bg-white px-6 py-12 text-center shadow-sm">
        <RefreshCw className="mx-auto text-gray-400" size={36} />
        <h2 className="mt-4 text-lg font-semibold text-gray-800">準備中</h2>
        <p className="mt-2 text-sm text-gray-500">
          自動抽出機能は現在開発中です。公開までしばらくお待ちください。
        </p>
      </div>
    </div>
  )
}
