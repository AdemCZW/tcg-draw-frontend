<script setup lang="ts">
/**
 * 卡片上傳入庫：把手上的實體卡登記進自己的卡冊。
 *
 * 兩塊：挑卡（用建池表單同一顆 CardPicker —— 卡片身分用挑的不用打字，
 * 打出來的字串永遠對不到目錄）+ 鑑定資訊（機構／編號／等級）。
 *
 * 登記成功的卡 status 是 in_book、tier 是 **null**：它沒進過任何池，
 * 賞別對它不成立（見 types/models.ts 的說明）。卡也還在使用者自己手上
 * （保管人是自己），所以沒有寄存期限。
 *
 * 四種失敗要分開呈現，尤其是兩種 409：
 *   CERT_ALREADY_LISTED  編號登記在**別人**名下 —— 出口是「申請接管」，
 *                        比照開池表單：入口只在被擋住的那一刻存在
 *   ALREADY_IN_BOOK      已經在自己卡冊裡 —— 不是錯誤是提醒，
 *                        講清楚那張卡現在是什麼狀態
 *                        （接管那支端點用的字是 CERT_ALREADY_YOURS，
 *                          意思相同，兩個都要收）
 *
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import CardPicker from '@/components/CardPicker.vue'
import CardFrontUpload from '@/components/CardFrontUpload.vue'
import { cardbookApi } from '@/lib/api'
import { ApiError } from '@/lib/http'
import type { PickedCard } from '@/lib/card-pick'
import type { Grader } from '@/types/models'
import { track } from '@/lib/ga'

const router = useRouter()

/* ---- 挑卡 ----
   max=1：登記是「一張實體卡」的動作。要登記三張就走三次 ——
   鑑定編號一張一個，批次表單只會讓編號跟卡對不上。 */
const picked = ref<PickedCard[]>([])
const pick = computed(() => picked.value[0] ?? null)
const entryMode = ref<'catalog' | 'manual'>('catalog')
const manualName = ref('')
const manualSetCode = ref('')
const manualCardNo = ref('')
const manualLanguage = ref<'JP' | 'EN'>('JP')
const frontFileId = ref<string | null>(null)
const frontReady = ref(false)

/* ---- 鑑定資訊 ----
   選項照開池動線的既有集合（shared/domain.ts 的 Grader）。
   裸卡（RAW）沒有編號也沒有等級，欄位整塊收起來 ——
   留著一個灌不了值的輸入框只會讓人以為自己漏填了什麼。 */
const GRADERS: { k: Grader; label: string }[] = [
  { k: 'RAW', label: '裸卡（未鑑定）' },
  { k: 'PSA', label: 'PSA' },
  { k: 'BGS', label: 'BGS' },
  { k: 'ARS', label: 'ARS' }
]
const grader = ref<Grader>('RAW')
const certNo = ref('')
const grade = ref<number | null>(null)
/** 自己標的參考價。選填、只顯示 —— 不填就是 null，不能退成 0（0 讀起來是「不值錢」） */
const refPrice = ref<number | null>(null)

const graded = computed(() => grader.value !== 'RAW')

/* 換一張卡＝重新開始一次登記：鑑定資訊跟著那張卡帶進來（卡冊來的卡
   身分本來就完整），錯誤訊息一併清掉 —— 那是上一張卡的事。 */
watch(pick, c => {
  clearErrors()
  if (!c) {
    /* 沒有挑卡＝這幾格沒有來源。不清掉的話，切到手動模式之後
       上一張卡的鑑定資訊會原封不動留著，而挑卡器已經藏起來，
       使用者看不到那些值是從哪來的。 */
    grader.value = 'RAW'
    grade.value = null
    certNo.value = ''
    refPrice.value = null
    return
  }
  grader.value = (c.card.grader as Grader) || 'RAW'
  grade.value = c.card.grade ?? null
  certNo.value = c.card.certNo ?? ''
  refPrice.value = c.card.refPrice ?? null
})

/**
 * 換模式＝換一種「這是哪一張卡」的說法，前一種說法要整個放掉。
 *
 * 這裡原本什麼都沒做（切換鈕只叫了 clearErrors()，而那支只清錯誤訊息）。
 * 後果不是「多留了一點狀態」，是**送出的內容整個換人**：
 * submit() 寫的是 `pick.value?.card` 加 `?? manualName`，只要之前挑過目錄卡，
 * 那個 c 就是真值，手填的卡名／系列／卡號三格全部被 ?? 短路掉。
 * 而 watch(pick) 帶進來的鑑定編號、等級、參考價也一起被繼承 ——
 * 使用者填的是「手填卡名XYZ」，登記進卡冊的卻是他放棄的那張目錄卡。
 *
 * 挑卡器在手動模式是隱藏的，所以這些值在畫面上沒有任何來源可循。
 * 唯一說得通的行為就是：切到手動就把挑好的卡放掉。
 */
watch(entryMode, mode => {
  clearErrors()
  if (mode === 'manual') {
    // watch(pick) 會跟著把鑑定資訊清回預設值
    picked.value = []
  }
})

/* ---- 送出 ---- */
const busy = ref(false)
const error = ref('')
/** CERT_ALREADY_LISTED：可以拿去申請接管的編號。只在被擋住的那一刻存在 */
const takeover = ref<{ certNo: string; grader: string } | null>(null)
/** ALREADY_IN_BOOK：那句「現在是什麼狀態」的訊息。它是提醒不是錯誤 */
const yoursMsg = ref('')

function clearErrors() {
  error.value = ''
  takeover.value = null
  yoursMsg.value = ''
}

const canSubmit = computed(() =>
  !busy.value
  && (entryMode.value === 'catalog' ? !!pick.value : !!(
    manualName.value.trim() && manualSetCode.value.trim() && manualCardNo.value.trim() && frontReady.value && frontFileId.value
  ))
  && (!graded.value || certNo.value.trim().length > 0))

/** 送出鈕不能按時，缺的那件事講出來（禁用的按鈕解釋不了自己） */
const missing = computed(() => {
  if (entryMode.value === 'catalog' && !pick.value) return '先挑一張卡'
  if (entryMode.value === 'manual' && (!manualName.value.trim() || !manualSetCode.value.trim() || !manualCardNo.value.trim())) return '請填卡名、系列與卡號'
  if (entryMode.value === 'manual' && !frontReady.value) return '請先上傳卡片正面圖片'
  if (graded.value && !certNo.value.trim()) return '鑑定卡要填鑑定編號（卡殼上那串號碼）'
  return ''
})

async function submit() {
  if (!canSubmit.value) return
  clearErrors()
  busy.value = true
  track('cardbook_upload_submit')
  try {
    /* 明確依模式取值，不靠「pick 是不是 null」。
       ?? 的短路是隱性的：只要 pick 不小心有值，手填的欄位就會被吃掉，
       而畫面上完全看不出來。模式是使用者按出來的，那就照它讀。 */
    const c = entryMode.value === 'catalog' ? pick.value?.card : undefined
    const { prize } = await cardbookApi.upload({
      name: c?.name ?? manualName.value.trim(),
      setCode: c?.setCode ?? manualSetCode.value.trim(),
      cardNo: c?.cardNo ?? manualCardNo.value.trim(),
      artId: c?.artId ?? null,
      language: c?.language ?? manualLanguage.value,
      grader: grader.value,
      grade: graded.value ? grade.value : null,
      certNo: graded.value ? (certNo.value.trim() || null) : null,
      variantId: c?.variantId ?? null,
      refPrice: refPrice.value || null,
      frontFileId: entryMode.value === 'manual' ? frontFileId.value : null
    })
    track('cardbook_upload_success')
    /* 成功導回卡冊，網址帶剛登記那張的 id —— 卡冊靠它把「剛收進卡冊」
       標出來（跟抽卡、市場成交同一條回家路） */
    router.push({ name: 'cards', query: { new: prize.id } })
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CERT_ALREADY_LISTED') {
      /* 使用者做對了事卻被擋住：卡在他手上，編號掛在別人名下。
         出口（申請接管）要接在被擋住的當下 —— 比照開池表單的做法，
         帶著編號跳開單頁預填，他要做的只剩「說明怎麼拿到這張卡」。 */
      error.value = e.message
      const hit = e.data as { certNo?: string; grader?: string } | null
      takeover.value = {
        certNo: hit?.certNo || certNo.value.trim(),
        grader: hit?.grader || grader.value || 'PSA'
      }
    } else if (e instanceof ApiError
      && (e.code === 'ALREADY_IN_BOOK' || e.code === 'CERT_ALREADY_YOURS')) {
      /* 不是錯誤，是「你已經有它了」。訊息裡有現在的狀態，
         照原樣顯示並給一條回卡冊的路。

         **兩個代號都要收。** 真後端的卡冊上傳回的是 ALREADY_IN_BOOK
         （server/src/routes/cardbook.ts），接管開單那支回的是
         CERT_ALREADY_YOURS —— 兩支是不同的端點、各自的字。
         原本這裡只認後者，於是打真後端時這條分支**從來沒有被走到過**：
         那句「已經在你的卡冊裡了」會掉進最下面的泛用分支，
         被當成紅色錯誤顯示，而「回卡冊看這張卡」那條出路整個不見。 */
      yoursMsg.value = e.message
    } else {
      error.value = e instanceof ApiError ? e.message : '登記失敗，請稍後再試'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="container page upWrap">
    <h1>登記卡片</h1>
    <p class="lead muted">
      把手上的實體卡登記進卡冊。登記後可以上架到市場，也可以當開池的獎品。
      卡片還是在你手上 —— 登記只是讓系統知道「這張卡的身分與持有人」。
    </p>

    <!-- 第一步：挑卡。目錄挑身分；從卡冊挑到的是已經登記過的卡，
         送出會被擋下來並講清楚（那正是 ALREADY_IN_BOOK 的意思） -->
    <section class="panel card">
      <h2>這是哪一張卡</h2>
      <div class="entryTabs" role="radiogroup" aria-label="卡片來源">
        <button type="button" role="radio" :aria-checked="entryMode === 'catalog'" :class="{ on: entryMode === 'catalog' }" @click="entryMode = 'catalog'; clearErrors()">搜尋卡片目錄</button>
        <button type="button" role="radio" :aria-checked="entryMode === 'manual'" :class="{ on: entryMode === 'manual' }" @click="entryMode = 'manual'; clearErrors()">目錄沒有這張卡</button>
      </div>
      <p v-if="entryMode === 'catalog'" class="hint muted">從目錄挑出正確的版本 —— 同一組卡號可能有價差極大的不同版本。</p>
      <!-- on-upload-page：挑卡器空狀態的出路裡有一條「去登記一張卡」，
           在這一頁上它指的就是這一頁（P9 的死連結）。告訴它自己在哪，
           它會改成講「你已經在對的地方了，往上打字」 -->
      <CardPicker v-if="entryMode === 'catalog'" v-model="picked" :max="1" default-source="catalog" on-upload-page />

      <div v-else class="manualFields">
        <label class="fld"><span>卡片名稱</span><input v-model.trim="manualName" type="text" maxlength="120" placeholder="例：皮卡丘"></label>
        <label class="fld"><span>系列／彈別</span><input v-model.trim="manualSetCode" type="text" maxlength="40" placeholder="例：SV2a"></label>
        <label class="fld"><span>卡號</span><input v-model.trim="manualCardNo" type="text" maxlength="40" placeholder="例：025/165"></label>
        <label class="fld"><span>語言</span><select v-model="manualLanguage"><option value="JP">日文</option><option value="EN">英文</option></select></label>
        <CardFrontUpload v-model:file-id="frontFileId" v-model:ready="frontReady" />
      </div>

      <!-- 挑好的那張。挑卡器的貼底列只報數字，這裡把完整身分攤開 ——
           登記寫進系統的就是這一行，送出前要看得到 -->
      <div v-if="entryMode === 'catalog' && pick" class="pickedRow">
        <img
          v-if="pick.artUrl" class="pickedArt" :src="pick.artUrl" :alt="pick.card.name"
          loading="lazy" decoding="async">
        <span v-else class="pickedArt ph" aria-hidden="true"></span>
        <div class="pickedId">
          <p class="pickedName">{{ pick.card.name }}</p>
          <p class="pickedMeta mono">{{ pick.card.setCode || '—' }} · {{ pick.card.cardNo || '—' }}</p>
          <p v-if="pick.variant" class="pickedMeta">{{ pick.variant.label }}</p>
        </div>
      </div>
    </section>

    <!-- 第二步：鑑定資訊 -->
    <section class="panel card">
      <h2>鑑定狀態</h2>
      <div class="gradeTabs" role="radiogroup" aria-label="鑑定機構">
        <button
          v-for="g in GRADERS" :key="g.k"
          type="button" role="radio" :aria-checked="grader === g.k"
          class="gTab" :class="{ on: grader === g.k }"
          @click="grader = g.k; clearErrors()"
        >{{ g.label }}</button>
      </div>

      <!-- 裸卡沒有編號與等級，整塊收起來 -->
      <div v-if="graded" class="fields">
        <label class="fld">
          <span>鑑定編號</span>
          <input
            v-model="certNo" type="text" inputmode="numeric" autocomplete="off"
            placeholder="卡殼標籤上的號碼" @input="clearErrors()">
          <span class="fldWhy muted">
            編號是這張卡在系統裡的身分識別，也用來防止同一張卡被登記兩次。
          </span>
        </label>
        <label class="fld">
          <span>鑑定等級</span>
          <input
            v-model.number="grade" type="number" inputmode="decimal"
            min="1" max="10" step="0.5" placeholder="例：10">
        </label>
      </div>
      <p v-else class="hint muted">
        裸卡直接登記，不需要編號。之後送鑑定了，再用新的編號重新登記即可。
      </p>

      <label class="fld">
        <span>參考價（點，選填）</span>
        <input
          v-model.number="refPrice" type="number" inputmode="numeric"
          min="0" step="10" placeholder="不填就不顯示價格">
        <span class="fldWhy muted">只做顯示用，不參與任何金額計算。</span>
      </label>
    </section>

    <!-- 一般錯誤（含 CERT_ALREADY_LISTED 的訊息） -->
    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <!-- 編號登記在別人名下：出路接在被擋住的當下（比照開池表單） -->
    <div v-if="takeover" class="takeover" data-testid="takeover-box">
      <p class="takeoverT">這張卡真的在你手上嗎？</p>
      <p class="takeoverP">
        如果你是在站外買到這張實體卡，可以申請把編號接管到你名下。
        通過之後這張卡就是你的，登記、開池與上架都不會再被擋。
      </p>
      <RouterLink
        class="btn takeoverGo" data-testid="takeover-go"
        :to="{ name: 'support-new',
               query: { kind: 'takeover', certNo: takeover.certNo, grader: takeover.grader, from: 'upload' } }"
      >申請接管 {{ takeover.grader }} #{{ takeover.certNo }}</RouterLink>
    </div>

    <!-- 已經在自己卡冊裡：提醒不是錯誤，配色與出口都不一樣 -->
    <div v-if="yoursMsg" class="yours" role="status" data-testid="yours-box">
      <p class="yoursP">{{ yoursMsg }}</p>
      <RouterLink class="btn yoursGo" :to="{ name: 'cards' }">回卡冊看這張卡</RouterLink>
    </div>

    <button
      type="button" class="btn primary go"
      :disabled="busy" :class="{ notyet: !canSubmit }"
      @click="submit"
    >{{ busy ? '登記中…' : '登記進卡冊' }}</button>
    <p v-if="missing && !busy" class="missing muted" role="note">{{ missing }}</p>
  </div>
</template>

<style scoped>
/* grid / flex 子元素一律 min-width: 0；欄位 minmax(0, 1fr)（HANDOFF 2.1） */
.upWrap { min-width: 0; padding-top: 30px; padding-bottom: 60px; max-width: 720px; }
h1 { font-size: 22px; margin: 0 0 6px; }
h2 { font-size: 15.5px; margin: 0 0 4px; }
.lead { font-size: 13px; line-height: 1.7; margin: 0 0 18px; min-width: 0; }
.hint { margin: 0 0 12px; font-size: 12px; line-height: 1.6; min-width: 0; }
.muted { color: var(--muted); }
.mono { font-family: var(--font-mono); }

.panel { min-width: 0; padding: 16px; margin-bottom: 14px; display: grid; gap: 10px; }
.entryTabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 4px; border-radius: 8px; background: var(--surface-2); }
/* 44px 是觸控下限（原本 40px）。這兩顆是整頁的第一個決策點，
   按不準的代價是使用者留在錯的模式裡填完整張表 */
.entryTabs button { min-height: 44px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; }
.entryTabs button.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }
.manualFields { display: grid; gap: 12px; }

/* ---- 挑好的卡 ---- */
.pickedRow {
  min-width: 0;
  display: grid; grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px; align-items: center;
  padding: 10px; border-radius: 12px;
  background: var(--surface-2); border: 1px solid var(--line-soft);
}
.pickedArt {
  width: 56px; aspect-ratio: 63 / 88; object-fit: cover;
  border-radius: 6px; background: var(--surface-3); display: block;
}
.pickedId { min-width: 0; display: grid; gap: 2px; }
.pickedName {
  min-width: 0; margin: 0; font-size: 14px; font-weight: 700; line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pickedMeta {
  min-width: 0; margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---- 鑑定機構切換 ----
   四顆同寬的膠囊；手機一列放不下四個就折兩列（auto-fit 格線）。
   每顆 ≥44px 高，觸控下限。 */
.gradeTabs {
  min-width: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px; padding: 4px;
  background: var(--surface-2); border-radius: 16px;
}
.gTab {
  min-width: 0; min-height: 44px;
  border: 0; background: transparent; color: var(--muted);
  font-size: 13px; font-weight: 600;
  padding: 10px 8px; border-radius: 12px;
  transition: background .18s, color .18s;
}
.gTab.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }
.gTab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- 欄位 ---- */
.fields { min-width: 0; display: grid; gap: 12px; }
.fld { min-width: 0; display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--muted); }
.fld > span:first-child { font-weight: 600; color: var(--ink); }
/* select 一起吃這組樣式。
   原本只寫了 `.fld input`，於是手動模式那顆「語言」下拉是瀏覽器預設外觀 ——
   量到的高度只有 24px，連 44px 觸控下限的一半都不到，
   而且字級小於 16px 會讓 iOS Safari 在點下去時自動放大整頁。 */
.fld input, .fld select {
  min-width: 0;
  /* 16px 是底線：iOS Safari 對小於 16px 的輸入框會自動放大整頁 */
  padding: 11px 12px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.fld select { min-height: 44px; appearance: none; background-image: none; }
.fld input:focus, .fld select:focus { outline: none; border-color: var(--gold); }
.fld select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fldWhy { font-size: 11.5px; line-height: 1.6; min-width: 0; }

/* ---- 錯誤與兩種 409 ---- */
.err { margin: 0 0 12px; font-size: 13px; line-height: 1.7; color: var(--danger-ink); min-width: 0; }

/* 編號在別人名下：警示配色 + 唯一的出口按鈕（比照開池表單的接管入口） */
.takeover {
  min-width: 0; margin: 0 0 14px; padding: 14px;
  border-radius: 14px;
  background: var(--warn-wash); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  display: grid; gap: 8px;
}
.takeoverT { margin: 0; font-size: 14px; font-weight: 700; color: var(--warn-ink); }
.takeoverP { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--ink); }
.takeoverGo { justify-self: start; min-height: 44px; font-size: 13.5px; }

/* 卡號對不上：警示配色（跟接管同一級 —— 兩個都是「先停下來看一眼」），
   但它的主體是一張比對表而不是一顆按鈕。 */
.mismatch {
  min-width: 0; margin: 0 0 14px; padding: 14px;
  border-radius: 14px;
  background: var(--warn-wash); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  display: grid; gap: 10px;
}
.mmT { margin: 0; font-size: 14px; font-weight: 700; color: var(--warn-ink); }
.mmP { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--ink); }
/* 比對表：左欄是「這一格講的是什麼」，右欄是值。
   手機寬度不夠時右欄會被擠爆，所以 minmax(0, 1fr) 讓值自己換行而不是溢位。 */
.mmGrid {
  min-width: 0; margin: 0; padding: 10px;
  border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line-soft);
  display: grid; gap: 6px;
}
.mmRow {
  min-width: 0;
  display: grid; grid-template-columns: minmax(0, 100px) minmax(0, 1fr);
  gap: 10px; align-items: baseline;
}
.mmRow dt { min-width: 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.mmRow dd {
  min-width: 0; margin: 0; font-size: 13px; font-weight: 600; color: var(--ink);
  line-height: 1.6; overflow-wrap: anywhere;
}
.mmWhy { font-size: 11.5px; line-height: 1.7; margin: 0; min-width: 0; }
/* 勾選框整塊可點，高度不低於 44px（觸控下限）。
   checkbox 本身也放大到 20px —— 預設的 13px 在手機上按不準。 */
.mmConfirm {
  min-width: 0; min-height: 44px;
  display: grid; grid-template-columns: 20px minmax(0, 1fr);
  gap: 10px; align-items: center;
  padding: 10px 12px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line);
  font-size: 13px; line-height: 1.6; color: var(--ink);
  cursor: pointer;
}
.mmConfirm input { width: 20px; height: 20px; accent-color: var(--warn); margin: 0; }
.mmConfirm:focus-within { border-color: var(--gold); }
.mmNote { margin: 0; font-size: 11.5px; line-height: 1.7; min-width: 0; }

/* 已在自己卡冊：中性的提醒，不是警示 */
.yours {
  min-width: 0; margin: 0 0 14px; padding: 14px;
  border-radius: 14px;
  background: var(--info-wash); border: 1px solid color-mix(in srgb, var(--info-ink) 30%, transparent);
  display: grid; gap: 8px;
}
.yoursP { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--ink); }
.yoursGo { justify-self: start; min-height: 44px; font-size: 13.5px; }

/* ---- 送出 ---- */
.go { width: 100%; min-height: 48px; font-size: 15px; }
/* 條件還沒齊時按鈕降飽和但**可以按** —— 按下去 missing 那行會講缺什麼。
   禁用的按鈕解釋不了自己（跟開池表單同一條理由）。 */
.go.notyet { opacity: .55; }
.missing { margin: 8px 0 0; font-size: 12px; line-height: 1.6; text-align: center; min-width: 0; }

@media (max-width: 720px) {
  .upWrap { padding-top: 20px; padding-bottom: 44px; }
  h1 { font-size: 19px; }
  .panel { padding: 13px; }
  .gradeTabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
