/**
 * 收藏家等級。
 *
 * 等級只由「收藏積分」決定，而收藏積分跟錢包點數是兩回事：不能花、不能轉讓、
 * 不能兌換任何東西（見 docs/superpowers/specs/2026-09-15-collector-level-design.md）。
 * 放在 shared 是因為後端之後要用同一張表算公開卡冊與賣家頁的等級 ——
 * 門檻寫兩份的話，總有一天前端說你是大師、後端說你是資深。
 *
 * 名稱刻意不用寶可夢的官方用語（訓練家、冠軍），避免被讀成官方授權。
 */

export interface CollectorLevelDef {
  level: number
  name: string
  /** 達到這一級需要的最低收藏積分（含） */
  min: number
}

export const COLLECTOR_LEVELS: readonly CollectorLevelDef[] = [
  { level: 1, name: '新手收藏家', min: 1 },
  { level: 2, name: '收藏家', min: 10 },
  { level: 3, name: '資深收藏家', min: 30 },
  { level: 4, name: '大師收藏家', min: 100 },
  { level: 5, name: '傳奇收藏家', min: 300 }
]

/* 積分是整數事件的加總，理論上不會有小數或負數；但它最後是從 API 進來的，
   壞資料不該讓徽章顯示成奇怪的等級。一律捨去、低於 0 當 0。 */
function clean(points: number): number {
  return Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0
}

/** 0 = 還沒有等級（不顯示徽章），1..5 對應 COLLECTOR_LEVELS */
export function collectorLevelFor(points: number): number {
  const p = clean(points)
  let lv = 0
  for (const d of COLLECTOR_LEVELS) if (p >= d.min) lv = d.level
  return lv
}

export function collectorLevelName(level: number): string | null {
  return COLLECTOR_LEVELS.find(d => d.level === level)?.name ?? null
}

export interface CollectorProgress {
  level: number
  name: string | null
  points: number
  /** 下一級門檻；已經滿級時為 null */
  nextMin: number | null
  /** 還差幾分升級；已經滿級時為 null */
  toNext: number | null
  /** 目前等級區間內的進度 0..1。滿級為 1 */
  ratio: number
}

export function collectorProgress(points: number): CollectorProgress {
  const p = clean(points)
  const level = collectorLevelFor(p)
  const cur = COLLECTOR_LEVELS.find(d => d.level === level)
  const next = COLLECTOR_LEVELS.find(d => d.level === level + 1)
  if (!next) return { level, name: cur?.name ?? null, points: p, nextMin: null, toNext: null, ratio: 1 }
  /* 區間的起點：等級 0 從 0 算起，其他從該級門檻算起。
     用區間內的比例而不是 p / next.min —— 否則剛升上 100 分的人看到的是「已經滿 30%」，
     進度條一升級就從快滿掉回三分之一，看起來像退步。 */
  const floor = cur?.min ?? 0
  return {
    level, name: cur?.name ?? null, points: p,
    nextMin: next.min, toNext: next.min - p,
    ratio: (p - floor) / (next.min - floor)
  }
}
