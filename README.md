# 石垣島食べある記（iwonderful.okinawa）

WordPress の表示を、見た目ごとそのまま静的ファイルにしたサイト。Cloudflare Workers の静的アセットで公開。

- `npm run fetch` … WordPress からページ・CSS・JS・画像を `site/` に写す（再実行で続きから。`node scripts/mirror.mjs --fresh` でHTMLを取り直し）
- `npm run deploy` … 公開
- `npm run deploy:www` … www.iwonderful.okinawa → iwonderful.okinawa の転送（`www/`）を公開

検索は Google のサイト内検索へ。
ドメインを切り替えた後は `npm run fetch` は使えない（WordPress に届かないため止まる。取り直すときは hosts で古いサーバーに向ける）。
fx・fx2・117fx（サブドメイン）は別のサイト。
