import type { Browser } from 'playwright-core'

// サーバーレス環境(Vercel)では @sparticuz/chromium の軽量バイナリを、
// ローカル開発では通常の playwright パッケージが持つChromiumを使う。
// メルカリShops関連のスクレイパー(mercari_shops.ts / mercari.tsの
// Shops商品エンリッチメント)で共通利用する。
export async function launchHeadlessBrowser(): Promise<Browser> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

  if (isServerless) {
    const [{ chromium }, sparticuzChromiumModule] = await Promise.all([
      import('playwright-core'),
      import('@sparticuz/chromium'),
    ])
    const sparticuzChromium = sparticuzChromiumModule.default
    return chromium.launch({
      args: sparticuzChromium.args,
      executablePath: await sparticuzChromium.executablePath(),
      headless: true,
    })
  }

  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true })
}
