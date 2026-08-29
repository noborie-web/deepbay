import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // メルカリShopsスクレイパーがPlaywright(サーバーレス環境では@sparticuz/chromium)を
  // 使うため、これらのネイティブバイナリを含むパッケージはNext.jsのバンドル対象から
  // 除外し、そのままNode.jsのrequireで読み込ませる。
  serverExternalPackages: ["playwright-core", "playwright", "@sparticuz/chromium"],
};

export default nextConfig;
