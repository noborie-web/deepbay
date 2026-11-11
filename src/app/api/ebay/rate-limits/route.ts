import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchEbayRateLimits } from '@/lib/ebay-rate-limits'

// ユーザー要望(2026-11-11): eBayの実際の呼び出し上限を確認したい。
//
// 本番で確認した不具合(2026-11-08〜09): 同期が「exceeded usage limit on this
// call」で失敗していたが、11/7は3,857回通り11/8は2,238回で拒否されるなど、
// Kakehashiが数えていた回数では説明がつかなかった。上限も時間の区切りも
// 推測だったため、eBay自身が返す値を見られるようにする。
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // ユーザー報告(2026-11-11): 「unauthorized」とだけ返り、Kakehashiの未ログインか
  // eBayの拒否かが区別できなかった。どちらなのかが読んで分かる文言にする。
  if (!user) {
    return NextResponse.json(
      { error: 'Kakehashiにログインしていません。ログインしてから開いてください。' },
      { status: 401 },
    )
  }

  const force = req.nextUrl.searchParams.get('refresh') === '1'
  try {
    const limits = await fetchEbayRateLimits({ force })
    return NextResponse.json({
      ok: true,
      // 枠の厳しい順に並べる(どれが先に尽きるかが一目で分かる)
      limits: [...limits].sort((a, b) => a.remaining - b.remaining),
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        // 設定漏れが原因のことが多いので、どれが入っているかだけ返す(値は返さない)
        env: {
          EBAY_CLIENT_ID: Boolean((process.env.EBAY_CLIENT_ID ?? '').trim()),
          EBAY_CLIENT_SECRET: Boolean((process.env.EBAY_CLIENT_SECRET ?? '').trim()),
        },
      },
      { status: 502 },
    )
  }
}
