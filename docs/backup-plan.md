# VaultDraw 資料庫備份計畫

> 查詢日期：2026-09-15。全程唯讀查詢，沒有建立備份、沒有改設定、沒有連進資料庫。

## 一、現況：目前**完全沒有備份**

用 Railway CLI 5.41.3 與 Railway GraphQL API（只讀查詢）確認：

| 項目 | 查到的結果 |
| --- | --- |
| 方案 | 工作區 `ademczw's Projects`，**Hobby** 方案；本期帳單約 $5.67 |
| Postgres 服務 | `postgres`，映像 `ghcr.io/railwayapp-templates/postgres-ssl:18`（**Postgres 18**），EU West |
| Volume | `postgres-volume`，掛在 `/var/lib/postgresql/data`，已用 245MB / 5000MB |
| Volume 備份（手動＋自動） | `railway postgres pitr backup list` → `[]`；API `volumeInstanceBackupList` → `[]`。**一份都沒有** |
| 自動備份排程 | `railway postgres pitr schedule list` → `[]`；API `volumeInstanceBackupScheduleList` → `[]`。**沒開排程** |
| PITR（時間點還原） | 專案裡 `railway bucket list` 沒有任何 bucket，開 PITR 時 Railway 會自動建 `Postgres-PITR` bucket，所以判定**沒開** |
| 對外 TCP Proxy | `railway tcp-proxy list -s postgres` → 沒有。資料庫只走內網，外部（例如 GitHub Actions）目前連不到 |
| 異地備份（pg_dump） | repo 裡只有 `deploy-pages.yml` 一個 workflow，沒有任何備份腳本或排程 |

**換句話說**：如果 volume 壞掉、誤刪表、migration 寫錯，現在沒有任何東西可以還原。

沒查的東西：`railway postgres pitr status` 會用 SSH 進容器探測，為了守住「不進正式環境」的原則沒有跑；但由 bucket 不存在已可判定 PITR 沒開。

### Railway 文件怎麼說

- **Volume Backups**（[文件](https://docs.railway.com/volumes/backups)）
  - 位置：Railway 儀表板 → 專案 `vaultdraw-server` → 點 `postgres` 服務 → **Backups** 分頁。
  - 可以手動建立、刪除、還原；也可以勾自動排程，可以同時勾多個：
    - Daily：每 24 小時一份，保留 6 天
    - Weekly：每 7 天一份，保留 27 天
    - Monthly：每 30 天一份，保留 89 天
  - 增量＋Copy-on-Write，只收「備份獨有的資料」的儲存費，費率同 volume（$0.15 / GB / 月）。
  - 限制：手動備份上限是 volume 總容量的 50%；**把 volume wipe 掉，備份會一起消失**（所以它不算異地備份）。
  - 還原：在 Backups 分頁找日期 → Restore → Railway 會暫存一個變更（掛一顆新 volume 到同路徑）→ 檢查後按 Deploy。
  - 方案限制：文件**沒寫**需要 Pro。CLI／API 在 Hobby 工作區查詢時也沒有回報權限錯誤，但實際能不能開以儀表板為準。文件標註這是仍在開發中的功能。
- **PITR 時間點還原**（[文件](https://docs.railway.com/volumes/point-in-time-recovery)）
  - 用 pgBackRest 把 WAL 持續送到 Railway bucket；每週全備、每天差異備，保留最近 4 份全備，約 4 週內可以還原到任意秒。
  - 開啟：Backups 分頁按「Enable PITR」，或 `railway postgres pitr enable --service postgres`。**單機 Postgres 開啟時會 redeploy**（短暫斷線）。
  - 還原會建一個新服務 `postgres-restored-日期`，不動原本的資料庫，確認沒問題再切換。
  - 費用：bucket 儲存費＋上傳的網路 egress（$0.05 / GB），都以 zstd 壓縮後大小計。
  - 注意：映像要留在大版本 tag（目前 `postgres-ssl:18` 符合）。
- **官方建議**（[Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores)）：正式環境三層都做——Volume Backups、PITR、自己保管的 `pg_dump`。

## 二、建議做法

### 首選（今天就能做，5 分鐘）：開 Railway Volume Backups 的 Daily + Weekly

理由：不用寫程式、不用 redeploy、以目前 245MB 的資料量，每月成本幾乎是 $0（增量計費，估計每月不到 $0.10）。

使用者要自己按的步驟：

1. 打開 Railway 儀表板 → 專案 `vaultdraw-server` → 環境 `production` → 點 `postgres` 服務。
2. 進 **Backups** 分頁。
3. 在排程區勾 **Daily** 和 **Weekly**（想要保留更久再加 Monthly）。
4. 按一次 **手動建立備份（Create backup / Backup now）**，名稱例如 `initial`，確認列表出現一筆。
5. 之後每次跑資料庫 migration 前，先手動建立一份備份（也可用 CLI：`railway postgres pitr backup create --service postgres --name pre-migration`）。
6. 確認：`railway postgres pitr schedule list --service postgres` 和 `railway postgres pitr backup list --service postgres` 不再是空的。

如果 Backups 分頁顯示需要升級方案，改走下面「備援」當主要方案，並考慮 Pro（$20/月）。

### 加碼（可選，之後有真實交易量再開）：PITR

- 適合抓「誤刪表、migration 寫壞」這種兩次備份之間發生的事。
- 會 redeploy Postgres（短暫斷線），建議挑離峰時段開：Backups 分頁 → Enable PITR。
- 成本：以目前寫入量，bucket 儲存加 egress 估計每月 $1 以內；交易量上來後再觀察 `railway usage`。

### 備援（異地、不依賴 Railway 方案）：每天 `pg_dump` 上傳到 Cloudflare R2

Railway 的 volume 備份和資料庫在同一家、同一顆 volume 上；帳號出事或 volume 被 wipe 會一起沒。所以另外保一份在 Cloudflare R2。

#### 方案 B1（建議）：在 Railway 專案內建一個 cron 服務

優點：走 Railway 內網連 Postgres，**不用**對外開 TCP Proxy；R2 金鑰已經在用。

草稿（尚未建立，僅供參考）：

1. **Cloudflare 端（使用者操作）**
   - 開一個**新的** R2 bucket，例如 `vaultdraw-db-backups`，不要跟卡圖用的 bucket 混在一起。
   - 在 R2 → Manage API Tokens 建一個新 token，權限只給這個 bucket 的 Object Read & Write。
   - 在該 bucket 設 Lifecycle rule：物件 30 天後自動刪除（或依需求 90 天）。
2. **repo 端（之後請 agent 做）**：新增 `deploy/db-backup/` 目錄，內容大致如下
   - `Dockerfile`：
     ```dockerfile
     FROM postgres:18-alpine
     RUN apk add --no-cache aws-cli
     COPY backup.sh /backup.sh
     CMD ["sh", "/backup.sh"]
     ```
     （pg_dump 版本必須 ≥ 伺服器版本，所以用 18。）
   - `backup.sh`：
     ```sh
     set -eu
     STAMP=$(date -u +%Y%m%d-%H%M%S)
     KEY="postgres/vaultdraw-$STAMP.dump"
     pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
       | aws s3 cp - "s3://$BACKUP_R2_BUCKET/$KEY" \
           --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
     echo "uploaded $KEY"
     ```
     （跑完就結束，Railway cron 服務要求程式執行完要自己退出。）
3. **Railway 端（使用者操作）**
   - 專案內 New → GitHub Repo，選同一個 repo，Root Directory 設 `deploy/db-backup`。
   - Variables 設（值用 Railway 參照或貼上，不要寫進 repo）：
     - `DATABASE_URL` = `${{postgres.DATABASE_URL}}`（參照內網連線）
     - `R2_ACCOUNT_ID`
     - `BACKUP_R2_BUCKET` = `vaultdraw-db-backups`
     - `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` = 第 1 步新 token 的值
     - `AWS_DEFAULT_REGION` = `auto`
   - Settings → **Cron Schedule** 填 `0 19 * * *`（UTC 19:00 = 台灣凌晨 3:00）。
   - 不要綁公開網域。
4. **第一次驗收**：在儀表板對這個服務手動觸發一次，看 Logs 出現 `uploaded ...`，再到 R2 確認檔案大小合理（目前 DB 245MB，壓縮後應該只有幾十 MB）。

成本：cron 服務每天只跑一兩分鐘，運算費幾分錢；上傳到 R2 算 Railway egress，$0.05/GB，每月約 $0.05～0.10；R2 儲存前 10GB 免費，30 份幾十 MB 的檔案不會超過。**合計每月約 $0.1～0.3。**

#### 方案 B2（替代）：GitHub Actions 排程

- 需要先在 Railway 對 `postgres` 開 **TCP Proxy**，資料庫會多一個公開入口（有密碼保護，但攻擊面變大），且 dump 走公網 egress。
- 流程：workflow `on: schedule: cron: '0 19 * * *'` → 安裝 `postgresql-client-18` → `pg_dump` 公開連線字串 → 用 aws-cli 上傳 R2。連線字串與 R2 金鑰放 GitHub repo Secrets。
- 注意：這個 repo 是公開的話，workflow log 要避免印出任何連線資訊；GitHub 排程在 repo 60 天沒活動時會被自動停用。
- 因為要對外開資料庫，**不建議**優先採用，除非想完全不依賴 Railway 做排程。

### 還原演練（無論哪個方案，都要至少做一次）

備份沒還原過就不算備份。建議每季做一次：

1. 從 R2 下載最新 `.dump`。
2. 本機起一個空的 Postgres 18（例如 `docker run -e POSTGRES_PASSWORD=... -p 5433:5432 postgres:18`）。
3. `pg_restore --no-owner --dbname "postgresql://postgres:...@localhost:5433/postgres" vaultdraw-XXXX.dump`
4. 抽查幾張主要資料表筆數（使用者、訂單、卡片）是否跟正式環境大致相符。
5. Railway Volume Backup 的還原則可以在非正式環境演練，避免直接覆蓋 production。

## 三、使用者待辦總表

| 優先 | 做什麼 | 在哪裡 | 大概成本 |
| --- | --- | --- | --- |
| 1（今天） | 開 Daily + Weekly 自動備份，手動建一份 `initial` | Railway → postgres → Backups | < $0.10/月 |
| 2（本週） | 建 R2 備份專用 bucket、專用 token、30 天 lifecycle | Cloudflare R2 | 免費額度內 |
| 3（本週） | 讓 agent 寫 `deploy/db-backup/`，再到 Railway 新增 cron 服務、填變數與排程 | repo + Railway | $0.1～0.3/月 |
| 4（首次備份後） | 做一次還原演練 | 本機 Docker | 0 |
| 5（之後） | 交易量上來後考慮開 PITR（會 redeploy，挑離峰） | Railway → postgres → Backups | 約 $1/月起 |
| 常規 | 每次 migration 前手動建一份備份 | Railway Backups 或 CLI | 0 |
