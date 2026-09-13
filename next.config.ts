import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // メルカリShopsスクレイパーがPlaywright(サーバーレス環境では@sparticuz/chromium)を
  // 使うため、これらのネイティブバイナリを含むパッケージはNext.jsのバンドル対象から
  // 除外し、そのままNode.jsのrequireで読み込ませる。
  serverExternalPackages: ["playwright-core", "playwright", "@sparticuz/chromium"],
  // 実データで確認済み: serverExternalPackagesに指定していても、Vercelの
  // ファイルトレース(デプロイに含めるファイルの自動判定)はplaywright-core内部
  // で動的に読み込まれるbrowsers.json等を検出できず、本番で
  // "Cannot find module '.../playwright-core/browsers.json'" エラーになり
  // メルカリShopsのエンリッチメントが常に失敗していた。明示的に含める。
  outputFileTracingIncludes: {
    "**/*": [
      "./node_modules/playwright-core/**",
      "./node_modules/@sparticuz/chromium/**",
    ],
  },
};

export default nextConfig;
