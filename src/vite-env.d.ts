/// <reference types="vite/client" />

/* 這一行不能刪。tsconfig.app.json 沒有設 `types`，所以 `import.meta.env`
   的型別（ImportMetaEnv / ImportMeta）只有靠這個 reference 進得來 ——
   拿掉整個檔案，config.ts、ga.ts、social.ts、router/index.ts 四支會一起
   噴 TS2339「Property 'env' does not exist on type 'ImportMeta'」（實測）。

   原本檔案裡還有一段自訂的 `interface ImportMeta { readonly env: ImportMetaEnv }`。
   那一段本來是為了掛自訂的 ImportMetaEnv（含 PSA 相關的 VITE_ 變數）；
   ImportMetaEnv 隨 PSA 一起移除之後，它就只是跟 vite/client 內建的宣告
   逐字重複，所以刪掉。 */
