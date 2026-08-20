import { defineRailway, project, service, github, postgres, preserve } from "railway/iac";

/**
 * Railway 的基礎設施定義。
 *
 * 這個檔案是「宣告什麼該存在」，會跟線上環境做 diff —— 沒有宣告到的變數
 * 會被視為多餘而刪掉。原本這裡只列了三個變數，於是 `railway config plan`
 * 顯示要刪掉九個：LINE_CHANNEL_SECRET、R2 的三把金鑰與桶名／帳號、
 * ADMIN_EMAIL / ADMIN_PASSWORD、JWT_SECRET、PUBLIC_URL。
 * 那些是在 Railway 主控台手動設的，值不該進版控。
 *
 * preserve() 就是為這種情況存在的：宣告「這個變數要有，值沿用 Railway 上現有的」。
 * 這樣 diff 認得它們、不會刪，而密鑰仍然只存在 Railway 那一份。
 *
 * 之後在主控台新增變數時，記得回來這裡補一行 preserve()，
 * 否則下次 apply 又會把它算成多餘的。
 */
export default defineRailway(() => {
  const db = postgres("postgres");

  const web = service("web", {
    source: github("ademczw/tcg-draw-frontend", { branch: "main", rootDirectory: "server" }),
    env: {
      // 由這個檔案決定的值
      DATABASE_URL: db.env.DATABASE_URL,
      CORS_ORIGINS: "https://ademczw.github.io",
      FRONTEND_URL: "https://ademczw.github.io/tcg-draw-frontend",

      // 在 Railway 主控台設定、值不進版控的密鑰與設定
      JWT_SECRET: preserve(),
      PUBLIC_URL: preserve(),
      ADMIN_EMAIL: preserve(),
      ADMIN_PASSWORD: preserve(),
      LINE_CHANNEL_SECRET: preserve(),
      R2_ACCOUNT_ID: preserve(),
      R2_BUCKET: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
    },
  });

  return project("vaultdraw-server", {
    resources: [db, web],
  });
});
