interface Props {
  limit: number
  used: number
}

export default function ExtractionStats({ limit, used }: Props) {
  const remaining = limit - used

  return (
    <div className="grid grid-cols-3 divide-x border rounded-md bg-white mb-4">
      <div className="px-6 py-4">
        <p className="text-xs text-gray-500 mb-1">抽出可能回数</p>
        <p className="text-2xl font-semibold text-gray-800">{limit}</p>
      </div>
      <div className="px-6 py-4">
        <p className="text-xs text-gray-500 mb-1">抽出回数</p>
        <p className="text-2xl font-semibold text-gray-800">{used}</p>
      </div>
      <div className="px-6 py-4">
        <p className="text-xs text-gray-500 mb-1">抽出回数残高</p>
        <p className="text-2xl font-semibold text-gray-800">{remaining}</p>
      </div>
    </div>
  )
}
