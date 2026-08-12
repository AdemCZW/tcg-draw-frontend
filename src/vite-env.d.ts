/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * PSA Public API 的 bearer token —— 僅供本機開發直連 PSA 使用。
   * 放在 .env.local（已被 .gitignore 排除），正式環境改由後端代理持有。
   */
  readonly VITE_PSA_DEV_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
