# decode-uri-component（CommonJS 版の同梱）

`expo-router` は `query-string@7` を `require()` で使い、`query-string@7` は
`decode-uri-component` を `require()` して関数として呼ぶ。`decode-uri-component` の
脆弱性（GHSA-vcc3-ghjq-m6fr: 不正なパーセントエンコードでの指数的な処理によるサービス拒否）が
直ったのは 0.5.0 からで、0.5.0 は ESM のみのため `query-string@7` からは呼べない。
（`query-string` 自体を新しい版に上げると default export しか無く、`expo-router` の
`__importStar(require("query-string"))` から `parse` / `stringify` が見えなくなる。）

そこで 0.5.0 のコードをそのまま CommonJS にしたものをここに置き、`mobile/package.json` の
`overrides` で `decode-uri-component` をこのディレクトリに差し替えている。

`expo-router` が `query-string@7` をやめたら（`npm ls decode-uri-component` で確認）、
この `vendor/decode-uri-component` と `overrides` の該当行を削除する。
