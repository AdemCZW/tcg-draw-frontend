import { defineRailway, project, service, github, postgres } from "railway/iac";

export default defineRailway(() => {
  const db = postgres("postgres");

  const web = service("web", {
    source: github("ademczw/tcg-draw-frontend", { branch: "main", rootDirectory: "server" }),
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      CORS_ORIGINS: "https://ademczw.github.io",
      FRONTEND_URL: "https://ademczw.github.io/tcg-draw-frontend",
    },
  });

  return project("vaultdraw-server", {
    resources: [db, web],
  });
});
