// ------------------------------------------------------------------
// 卡片挑選器的交付格式。
//
// 為什麼不直接 emit CardItem：挑選器要回答的比 CardItem 多兩件事 ——
// 「這張是從卡冊挑的還是從目錄挑的」（前者對應一張實體卡，有 prizeId）、
// 「選的是哪一個變體」（CardItem 目前沒有這個欄位，見 variant 的說明）。
// 呼叫端要 CardItem 就取 .card，要多的資訊也拿得到，不必再查一次。
// ------------------------------------------------------------------

import type { CardItem } from '@/shared/domain'
import type { UserPrize } from '@/types/models'
import type { CatalogCard, CatalogVariant } from './tcgdex-catalog'
import { artUrlOf } from './tcgdex-catalog'

export type PickSource = 'cardbook' | 'catalog'

export interface PickedCard {
  /**
   * 選取的唯一鍵。卡冊卡一張實體卡只能挑一次（同一張卡不可能同時是兩個獎），
   * 目錄卡則是「同一組卡號的不同變體算不同的東西」—— 這兩條規則就寫在鍵裡，
   * 呼叫端不必自己判斷重複。
   */
  key: string
  source: PickSource
  /** 可以直接塞進獎品的卡片身分 */
  card: CardItem
  /** 卡冊來源才有。之後要把獎品綁到實體卡就是靠這個 */
  prizeId?: string
  /**
   * 目錄來源選中的變體。
   *
   * **變體的識別碼（variantId）已經寫進 card 裡**，而且進了 manifest v4，
   * 所以它是公平性承諾的一部分 —— 開賣後把大師球鏡面換成同卡號的普卡
   * 會被驗算抓到（那兩張卡實測差約 18,000 倍）。
   *
   * 這裡留著整個 CatalogVariant 物件是給**畫面**用的：label 是我們自己翻的
   * 中文、priceEur 是外站行情，兩者都會變，所以都不進承諾（改一次文案
   * 不該讓所有池變成「被竄改」）。承諾裡只有那個不會變的 variantId。
   */
  variant?: CatalogVariant | null
  /** 卡圖網址。已經算好，呼叫端不用再推 */
  artUrl: string | null
}

/** 卡冊裡的一張卡 → 挑選結果。這種卡本來就有完整身分，一個字都不用填 */
export function pickFromPrize(p: UserPrize): PickedCard {
  return {
    key: `prize:${p.id}`,
    source: 'cardbook',
    prizeId: p.id,
    card: { ...p.card },
    variant: null,
    artUrl: p.card.artId ? artUrlOf({ artId: p.card.artId }) : null
  }
}

/**
 * 目錄卡 → 挑選結果。
 *
 * grader 給 RAW、certNo 給 null：目錄查到的是「這張卡的卡面」，不是任何一張
 * 被鑑定過的實體卡。填一個假的鑑定資訊比留空危險得多 —— 整套爭議判定
 * 都建立在 certNo 可以對外查證上。
 *
 * refPrice 一樣留 null 不要填 0：0 在畫面上讀起來是「這張卡不值錢」。
 * 目錄的 cardmarket 價格是歐元的外站行情，不是這個平台的參考價，
 * 換算匯率會變成一個沒人負責的數字，所以不自動代入，只在挑選介面上顯示給人看。
 */
export function pickFromCatalog(c: CatalogCard, variant: CatalogVariant | null): PickedCard {
  return {
    key: `catalog:${c.artId}:${variant?.variantId ?? ''}`,
    source: 'catalog',
    card: {
      id: c.artId,
      name: c.name,
      setCode: c.setCode,
      cardNo: c.cardNo,
      language: 'JP',
      grader: 'RAW',
      grade: null,
      certNo: null,
      image: '',
      refPrice: null,
      artId: c.artId,
      /* 變體識別碼進 card —— 它是「這是哪一張卡」的一部分，
         而且會被序列化進 manifest v4 綁死。沒選變體就是 null，不要填空字串：
         manifest 把 null 與空字串序列化成同一個東西，但資料庫裡兩者
         讀起來意思不同（「沒有變體」vs「變體是空的」）。 */
      variantId: variant?.variantId ?? null
    },
    variant,
    artUrl: artUrlOf(c)
  }
}
