/* VaultDraw 收藏與行情 demo（示意資料）。從 collector-market.html 拆出來：
   網站的 CSP 不允許 inline script。 */
/* ==========================================================
   兌換卡包（草案）—— 門檻還在研究，改數字只要改這裡
   ========================================================== */
/** 第一包需要的可兌換額度（每支手機號碼只有一次） */
const PACK_FIRST_COST = 10;
/** 之後每一包需要的可兌換額度 */
const PACK_COST = 30;
/** 每個帳號每季最多換幾包 */
const PACK_PER_QUARTER = 1;
/** 冷卻期：登記滿幾天才算進可兌換額度 */
const PACK_COOLDOWN_DAYS = 30;
/** 顯示在兌換區塊最上面的說明 */
const PACK_NOTE = '草案：正式規則目前仍是「收藏積分不能兌換任何東西」，要改規格才會生效。';
/** 草案條件（依研究文件 docs/pack-reward-research.md、pack-reward-legal.md） */
const PACK_RULES = [
  `第一包 ${PACK_FIRST_COST} 分（每支手機號碼只有一次），之後每 ${PACK_COST} 分換一包繁中擴充包`,
  '等級分與可兌換額度分開算：換卡包只扣額度，不會降級',
  `只有照片經人工確認、登記滿 ${PACK_COOLDOWN_DAYS} 天、而且沒被檢舉的鑑定卡，才算進可兌換額度`,
  '第一階段只算登記；站內買卡的分，要等站內付款能驗證之後才算',
  `每個帳號每季最多 ${PACK_PER_QUARTER} 包；同一個收件地址或電話每期 1 包；要先做手機驗證`,
  '兌換後才發現造假：記成負的額度並凍結兌換，不向對方追討金錢'
];
/** 一定不做的事（碰到就可能被認定有對價） */
const PACK_NEVER = [
  '積分可以轉讓，或換成錢包點數、折抵任何交易',
  '用錢取得積分（包含付手續費送積分、兌換時補差價）',
  '平台收回卡包或開出來的卡，或替玩家代開後把結果當獎品'
];

/* 示範收藏家的可兌換額度（跟等級分分開）。等級分會因為買卡、未審照片等而比額度高 */
const REDEEM_INIT = { confirmed: 14, cooling: 3, reviewing: 2, firstUsed: false, quarterUsed: 0 };
let redeem = { ...REDEEM_INIT };
const nextPackCost = () => (redeem.firstUsed ? PACK_COST : PACK_FIRST_COST);

/* ==========================================================
   收藏家等級（對應 src/shared/collector.ts）
   ========================================================== */
const COLLECTOR_LEVELS = [
  { level: 1, name: '新手收藏家', min: 1 },
  { level: 2, name: '收藏家', min: 10 },
  { level: 3, name: '資深收藏家', min: 30 },
  { level: 4, name: '大師收藏家', min: 100 },
  { level: 5, name: '傳奇收藏家', min: 300 }
];
const cleanPts = p => Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0;
function levelFor(points) { const p = cleanPts(points); let lv = 0; for (const d of COLLECTOR_LEVELS) if (p >= d.min) lv = d.level; return lv; }
function levelName(level) { const d = COLLECTOR_LEVELS.find(x => x.level === level); return d ? d.name : null; }
function progress(points) {
  const p = cleanPts(points), level = levelFor(p);
  const cur = COLLECTOR_LEVELS.find(d => d.level === level), next = COLLECTOR_LEVELS.find(d => d.level === level + 1);
  if (!next) return { level, points: p, nextMin: null, toNext: null, ratio: 1 };
  const floor = cur ? cur.min : 0;
  return { level, points: p, nextMin: next.min, toNext: next.min - p, ratio: (p - floor) / (next.min - floor) };
}

/* ---------- 示意資料 ---------- */
const CARDS = {
  tera: { name: '太樂巴戈斯 ex UR', set: 'SV8a 237/187', th: 'th2' },
  zard: { name: '噴火龍 ex SAR', set: 'SV4a 349/190', th: 'th1' },
  zardU: { name: '噴火龍 ex UR', set: 'SV4a 349/190', th: 'th4' },
  pika: { name: '皮卡丘 ex SAR', set: 'SV8a 236/187', th: 'th2' },
  kieran: { name: '奇樹 SAR', set: 'SV4a 350/190', th: 'th3' },
  umbreon: { name: '月亮伊布 ex SAR', set: 'SV8a 217/187', th: 'th1' },
  drag: { name: '多龍巴魯托 ex SAR', set: 'SV8a 221/187', th: 'th3' },
  eevee: { name: '伊布 ex SAR', set: 'SV8a 223/187', th: 'th4' }
};
const GRADES = ['PSA 10', 'PSA 9', '未鑑定'];
/* 「我的」頁的使用者。他的等級是即時算的，所以別處出現他時徽章會跟著變 */
const ME = '示範收藏家';
/* 其他人的收藏積分（示意） */
const USERS = { '滿分保庫': 47, '保庫堂': 132, '關都卡舖': 318, '卡友小林': 4, '新來的卡友': 0 };
/* 成交：daysAgo, price, cert, kind, seller */
const TX = {
  tera: {
    'PSA 10': [[28, 17800, '83871102', '本站市場', '卡友小林'], [22, 18600, '84001337', '庫內轉移', '保庫堂'], [17, 18200, '83990214', '本站市場', '關都卡舖'], [11, 19400, '83990214', '本站市場', ME], [5, 18900, '84125517', '庫內轉移', '新來的卡友'], [1, 18200, '84120031', '本站市場', '保庫堂']],
    'PSA 9': [[25, 9800, '82011450', '本站市場', '卡友小林'], [9, 10400, '82231907', '本站市場', '滿分保庫'], [3, 10100, '82011450', '庫內轉移', '關都卡舖']],
    '未鑑定': []
  },
  zard: {
    'PSA 10': [[27, 8200, '84440012', '本站市場', '關都卡舖'], [19, 8600, '84440871', '本站市場', '保庫堂'], [12, 8400, '84452233', '庫內轉移', '卡友小林'], [6, 8900, '84440012', '本站市場', '滿分保庫'], [2, 9100, '84471190', '本站市場', '新來的卡友']],
    'PSA 9': [], '未鑑定': [[14, 2600, null, '本站市場', '卡友小林']]
  }
};
const HISTORY = {
  '84120031': [['2026-08-02', '從「關都卡舖 SV8a 池」抽出', '第 17 籤'], ['2026-08-21', '登記進卡冊', '編號全站唯一'], ['2026-09-14', '站內轉手', '成交 NT$18,200']],
  '83990214': [['2026-07-11', '登記進卡冊', '持有人自己上傳'], ['2026-08-18', '站內轉手', '成交 NT$18,200'], ['2026-09-04', '站內轉手', '成交 NT$19,400']]
};
const REGISTRY = {
  '84120031': { card: 'tera', grade: 'PSA 10', at: '2026-08-21', owner: '滿分保庫', now: '刊登中 NT$18,800', moves: '1 次，最近一次 NT$18,200' },
  '83990214': { card: 'tera', grade: 'PSA 10', at: '2026-07-11', owner: '保庫堂', now: '在卡冊中（未刊登）', moves: '2 次，最近一次 NT$19,400' },
  '84440012': { card: 'zard', grade: 'PSA 10', at: '2026-06-30', owner: ME, now: '在卡冊中（未刊登）', moves: '1 次，最近一次 NT$8,900' }
};
const TOP = {
  7: [['zard', 38, 21], ['pika', 26, 14], ['kieran', 19, 9]],
  30: [['zard', 121, 64], ['tera', 88, 51], ['umbreon', 70, 33]]
};
const LATEST = [['tera', 'PSA 10', 18200, '本站市場', '12 分鐘前', '保庫堂'], ['umbreon', 'PSA 10', 26300, '庫內轉移', '1 小時前', '關都卡舖'], ['zard', 'PSA 10', 9100, '本站市場', '3 小時前', '新來的卡友']];
const MOVERS = [['drag', 'PSA 10', 7, 12.4, '2,16 12,14 22,15 32,9 42,7 52,3'], ['eevee', 'PSA 10', 6, -8.1, '2,4 12,6 22,5 32,11 42,13 52,16']];

/* 示範收藏家的積分紀錄（新到舊）。畫面只列最近幾筆，更早的合計在 EARLIER */
const EARLIER = { count: 29, sum: 25 };
const LEDGER_INIT = [
  { date: '2026-09-12', delta: 1, reason: '登記鑑定卡', card: 'zard', cert: '84440871' },
  { date: '2026-09-08', delta: -1, reason: '訂單退款', card: 'pika', cert: '82231907', why: '抵銷當初買到這張的 1 分' },
  { date: '2026-09-03', delta: 1, reason: '站內買到卡', card: 'pika', cert: '82231907' },
  { date: '2026-08-29', delta: -1, reason: '編號被檢舉成立', card: 'kieran', cert: '83700415', why: '抵銷當初登記的 1 分' },
  { date: '2026-08-27', delta: 1, reason: '登記鑑定卡', card: 'umbreon', cert: '84501220' },
  { date: '2026-08-20', delta: 1, reason: '站內買到卡', card: 'drag', cert: '84390017' },
  { date: '2026-08-11', delta: 1, reason: '登記鑑定卡', card: 'kieran', cert: '83700415' },
  { date: '2026-08-02', delta: -1, reason: '自己刪除登記', card: 'eevee', cert: '83155006', why: '抵銷當初登記的 1 分' }
];
const LEDGER_SHOW = 8;
let ledger = LEDGER_INIT.map(e => ({ ...e }));
const mePoints = () => Math.max(0, EARLIER.sum + ledger.reduce((a, e) => a + e.delta, 0));
const pointsOf = who => who === ME ? mePoints() : (USERS[who] ?? 0);

/* ---------- 狀態 ---------- */
const st = { view: 'home', range: 7, card: 'tera', grade: 'PSA 10', cert: '84120031', open: null, q: '', owner: ME, lvup: null };
const stack = [];
const MAIN = ['home', 'cert', 'card', 'me'];
const $ = s => document.querySelector(s);
const screen = $('#screen');
const nt = n => 'NT$' + n.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let justLeveled = false, shownRatio = null, simTimer = null;

function go(patch, push = true) {
  if (push) stack.push({ ...st });
  Object.assign(st, patch, { open: patch.open ?? null });
  render();
  screen.scrollTop = 0;
}
function back() { const prev = stack.pop(); if (prev) { Object.assign(st, prev); render(); } }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- 徽章 ---------- */
let gid = 0;
function badge(level, opt = {}) {
  const name = levelName(level);
  if (!name) return '';                       /* 等級 0 不畫任何東西 */
  const size = opt.size || 'sm', showName = opt.name !== false, id = 'cbh' + (++gid);
  const label = `收藏家等級 ${level}：${name}`;
  const svg = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">${level === 5 ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--holo-a)"/><stop offset=".5" style="stop-color:var(--holo-b)"/><stop offset="1" style="stop-color:var(--holo-c)"/></linearGradient></defs>` : ''}<path class="shield" d="M12 2 20.5 7v10L12 22 3.5 17V7Z"${level === 5 ? ` style="fill:url(#${id})"` : ''}/>${level >= 4 ? '<path class="inner" d="M12 6.5 16.8 9.3v5.4L12 17.5 7.2 14.7V9.3Z"/>' : ''}<text class="bn" x="12" y="15.2" text-anchor="middle">${level}</text></svg>`;
  return `<span class="cb lv${level} ${size}${showName ? '' : ' icon'}${opt.cls ? ' ' + opt.cls : ''}" role="img" aria-label="${label}" title="${label}">${svg}${showName ? `<span class="cbn">${name}</span>` : ''}</span>`;
}
const whoLine = (label, who) => `<span class="who"><span class="n">${label} ${esc(who)}</span>${badge(levelFor(pointsOf(who)), { name: false })}</span>`;

const searchIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function searchBox(ph) {
  return `<div class="searchBox"><label class="search">${searchIcon}<input id="q" type="search" autocomplete="off" placeholder="${ph}" value="${esc(st.q)}" aria-label="搜尋卡名或鑑定編號"></label><div class="sug" id="sug" hidden></div></div>`;
}

/* ---------- 畫面：行情 ---------- */
function home() {
  const top = TOP[st.range].map(([id, n, g]) => `<button class="row" type="button" data-card="${id}" data-grade="PSA 10"><span class="thumb ${CARDS[id].th}"></span><div><div class="nm">${CARDS[id].name}</div><div class="sub">${CARDS[id].set}</div></div><div class="right"><span class="price num">${n} 張</span><span class="grade">PSA 10 · ${g}</span></div></button>`).join('');
  const latest = LATEST.map(([id, g, p, k, w, seller]) => `<button class="row" type="button" data-card="${id}" data-grade="${g}"><span class="thumb ${CARDS[id].th}"></span><div><div class="nm">${CARDS[id].name}</div><div class="sub"><span class="chip site">${k}</span> ${w}</div>${whoLine('賣家', seller)}</div><div class="right"><span class="price num">${nt(p)}</span><span class="grade">${g}</span></div></button>`).join('');
  const movers = MOVERS.map(([id, g, n, pct, pts]) => `<button class="row" type="button" data-card="${id}" data-grade="${g}"><span class="thumb ${CARDS[id].th}"></span><div><div class="nm">${CARDS[id].name}</div><div class="sub">${g} · ${n} 筆</div></div><div class="right"><svg class="spark" viewBox="0 0 54 20" aria-hidden="true"><polyline points="${pts}" style="stroke:var(${pct > 0 ? '--ok' : '--danger'})"/></svg><span class="${pct > 0 ? 'up' : 'dn'} num">${pct > 0 ? '+' : '−'}${Math.abs(pct)}%</span></div></button>`).join('');
  return `${searchBox('搜卡名，或輸入鑑定編號')}
    <p class="hintline">輸入 8 位數字按 Enter，直接查這個編號有沒有人登記</p>
    <section class="sec"><div class="sechead"><h3>登記最多</h3><div class="seg">
      <button type="button" class="hit ${st.range === 7 ? 'on' : ''}" data-range="7">7 天</button>
      <button type="button" class="hit ${st.range === 30 ? 'on' : ''}" data-range="30">30 天</button></div></div>
      <div class="list">${top}</div></section>
    <section class="sec"><div class="sechead"><h3>最新成交</h3><small>只列本站成交 · 示意</small></div><div class="list">${latest}</div></section>
    <section class="sec"><div class="sechead"><h3>30 天漲跌</h3><small>至少 5 筆成交才列入</small></div><div class="list">${movers}</div></section>`;
}

/* ---------- 畫面：查編號 ---------- */
function cert() {
  const r = REGISTRY[st.cert];
  let body;
  if (!st.cert) {
    body = `<div class="empty">輸入鑑定編號，看它有沒有被登記、現在在誰的卡冊。</div>`;
  } else if (r) {
    const c = CARDS[r.card];
    body = `<div class="reg">
      <div class="regtop"><div class="slab" aria-hidden="true"><i></i><u class="${c.th}"></u></div>
        <div style="display:grid;gap:6px;min-width:0"><span class="status">已登記</span><div class="nm" style="font-size:15px">${c.name}</div><div class="sub">${c.set} · 日版</div><span class="grade" style="font-size:12px">${r.grade} · #${st.cert}</span></div></div>
      <dl class="kv">
        <div><dt>登記於</dt><dd class="num">${r.at}</dd></div>
        <div><dt>持有人</dt><dd class="owner"><span>${esc(r.owner)}</span>${badge(levelFor(pointsOf(r.owner)))}<button class="link hit" type="button" data-book="${esc(r.owner)}">看公開卡冊</button></dd></div>
        <div><dt>目前</dt><dd>${r.now}</dd></div>
        <div><dt>站內轉手</dt><dd>${r.moves}</dd></div>
      </dl>
      ${HISTORY[st.cert] ? `<button class="btn" type="button" data-card="${r.card}" data-grade="${r.grade}" data-open="${st.cert}">看這張卡的來歷</button>` : ''}
      <div class="note"><b>登記不代表真偽。</b>VaultDraw 只保證同一個編號全站只能登記一次，卡片真假請到鑑定公司官網核對。</div>
      <div class="btns"><button class="btn" type="button" data-toast="示意：這裡會開 PSA 官網查 #${st.cert}">到 PSA 官網核對</button><button class="btn primary" type="button" data-card="${r.card}" data-grade="${r.grade}">這款卡的行情</button></div>
    </div>`;
  } else {
    body = `<div class="reg">
      <span class="status no">還沒有人登記</span>
      <div class="nm num" style="font-size:15px">#${esc(st.cert)}</div>
      <p class="sub" style="margin:0;font-size:12.5px">目前沒有人登記這個編號。如果這張卡在你手上，登記之後別人就不能再用這個編號，你也會得到 1 分收藏積分。</p>
      <div class="note"><b>也可能是打錯了。</b>PSA 的編號通常是 8 到 9 位數字，印在鑑定盒標籤右上角。</div>
      <button class="btn primary" type="button" data-toast="示意：這裡會進「登記卡片」並帶入這個編號">登記這張卡</button>
    </div>`;
  }
  return `${searchBox('輸入鑑定編號，例如 84120031')}${body}`;
}

/* ---------- 畫面：卡片行情 ---------- */
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function chart(rows) {
  const L = 36, R = 292, T = 12, B = 96;
  const prices = rows.map(r => r[1]);
  const lo = Math.floor((Math.min(...prices) - 300) / 500) * 500;
  const hi = Math.ceil((Math.max(...prices) + 300) / 500) * 500;
  const x = d => L + (30 - d) / 30 * (R - L);
  const y = v => T + (hi - v) / (hi - lo) * (B - T);
  const mid = (lo + hi) / 2;
  const pts = rows.map(r => [x(r[0]).toFixed(1), y(r[1]).toFixed(1)]);
  const med = median(prices);
  const line = pts.map(p => p.join(',')).join(' ');
  const area = `${line} ${pts[pts.length - 1][0]},${B} ${pts[0][0]},${B}`;
  const dots = pts.map((p, i) => `<circle class="${i === pts.length - 1 ? 'last' : 'dot'}" cx="${p[0]}" cy="${p[1]}" r="${i === pts.length - 1 ? 4.2 : 3.2}"/>`).join('');
  return `<figure class="chart" aria-label="近 30 天成交價，共 ${rows.length} 筆"><svg viewBox="0 0 300 120" role="img">
    ${[hi, mid, lo].map(v => `<line class="grid" x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}"/><text class="axis" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v.toLocaleString('en-US')}</text>`).join('')}
    <line class="med" x1="${L}" y1="${y(med)}" x2="${R}" y2="${y(med)}"/>
    <text class="medl" x="${R - 2}" y="${Math.min(B - 2, y(med) + 11)}" text-anchor="end">中位數 ${med.toLocaleString('en-US')}</text>
    ${rows.length > 1 ? `<polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>` : ''}
    ${dots}
    <text class="axis" x="${L}" y="113">30 天前</text><text class="axis" x="${R}" y="113" text-anchor="end">今天</text>
  </svg></figure>`;
}
function daysToDate(d) { const t = new Date(Date.UTC(2026, 8, 15) - d * 86400000); return t.toISOString().slice(0, 10); }

function card() {
  const c = CARDS[st.card];
  const rows = ((TX[st.card] || {})[st.grade] || []).slice().sort((a, b) => b[0] - a[0]);
  const tabs = GRADES.map(g => `<button type="button" class="hit ${g === st.grade ? 'on' : ''}" data-grade-tab="${g}">${g}</button>`).join('');
  let body;
  if (!rows.length) {
    body = `<div class="empty">這個分數還沒有本站成交。<br>有成交之後，價格與走勢會出現在這裡。</div>`;
  } else {
    const prices = rows.map(r => r[1]);
    const last = rows[rows.length - 1];
    const list = rows.slice().reverse().map(([d, p, certNo, k, seller], i) => {
      const key = `${certNo}-${i}`;
      const open = st.open === certNo && HISTORY[certNo];
      const hist = open ? `<ol class="tl">${HISTORY[certNo].map(([t, a, b]) => `<li><div class="t num">${t}</div><b>${a}</b>，${b}</li>`).join('')}</ol>` : '';
      const more = certNo ? (HISTORY[certNo] ? (open ? '收起' : '看來歷') : '無來歷紀錄') : '未鑑定';
      return `<div class="tx"><button class="txHead" type="button" ${certNo && HISTORY[certNo] ? `data-toggle="${certNo}"` : `data-toast="示意：這筆沒有可展開的來歷紀錄"`} aria-expanded="${open ? 'true' : 'false'}" data-key="${key}">
        <span class="price num">${nt(p)}</span><span class="chip site">${k}</span>
        <span class="when num">${daysToDate(d)}${certNo ? ' · #' + certNo : ''}</span><span class="more">${more}</span>${seller ? whoLine('賣家', seller) : ''}</button>${hist}</div>`;
    }).join('');
    body = `<dl class="stats"><div><dt>最近成交</dt><dd class="num">${last[1].toLocaleString('en-US')}</dd></div>
      <div><dt>30 天中位數</dt><dd class="num">${median(prices).toLocaleString('en-US')}</dd></div>
      <div><dt>30 天成交</dt><dd class="num">${rows.length} <small>筆</small></dd></div></dl>
      ${chart(rows)}
      <p class="hintline" style="margin:-6px 2px 0">每一個點是一筆本站成交（示意），不是掛價，也不是其他網站的價格</p>
      <section class="sec"><div class="sechead"><h3>成交紀錄</h3><small>新台幣 · 點一筆看來歷</small></div><div class="list">${list}</div></section>`;
  }
  return `<div class="head"><span class="thumb ${c.th}"></span><div><h3>${c.name}</h3><div class="sub">${c.set} · 日版</div><div class="tabs">${tabs}</div></div></div>${body}`;
}

/* ---------- 畫面：我的 ---------- */
function me() {
  const p = progress(mePoints());
  const startW = shownRatio === null || justLeveled ? (justLeveled ? 0 : p.ratio) : shownRatio;
  const nextName = p.toNext !== null ? levelName(p.level + 1) : null;
  const lvup = st.lvup ? `<div class="lvup" role="status">${badge(st.lvup, { size: 'md', name: false, cls: justLeveled ? 'pop' : '' })}<div><b>升到 ${st.lvup} 級：${levelName(st.lvup)}</b><br>公開卡冊、賣家頁的徽章也會一起換（示意）。</div></div>` : '';

  const shown = ledger.slice(0, LEDGER_SHOW);
  const hidden = ledger.slice(LEDGER_SHOW);
  const olderCount = EARLIER.count + hidden.length;
  const olderSum = EARLIER.sum + hidden.reduce((a, e) => a + e.delta, 0);
  const rows = shown.map(e => {
    const c = e.card ? CARDS[e.card] : null;
    return `<div class="lg${e.sim ? ' sim' : ''}"><span class="d ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+1' : '−1'}</span><div>
      <div class="r">${e.reason}</div>
      <div class="c">${c ? `${c.name} · <span class="num">#${e.cert}</span>` : '只是 demo 裡的模擬，不對應任何卡片'}${e.why ? `<br>${e.why}` : ''}</div>
      <div class="w num">${e.date}</div></div></div>`;
  }).join('');

  const pts = mePoints();
  const cost = nextPackCost();
  const quarterLeft = PACK_PER_QUARTER - redeem.quarterUsed;
  const canRedeem = redeem.confirmed >= cost && quarterLeft > 0;
  const packStatus = quarterLeft <= 0
    ? `這一季已經換過 ${PACK_PER_QUARTER} 包，下一季再來`
    : canRedeem
      ? `可以換${redeem.firstUsed ? '' : '第一'}包`
      : `再 <span class="num">${cost - redeem.confirmed}</span> 分可以換${redeem.firstUsed ? '下一' : '第一'}包`;

  return `<div class="profile"><span class="avatar" aria-hidden="true"></span><div style="min-width:0">
      <h3>${ME}</h3><span class="demoTag">示意資料：人名、分數、紀錄都是假的</span></div></div>

    <section class="card" aria-label="收藏家等級">
      <div class="cpTop">
        ${p.level > 0 ? badge(p.level, { size: 'md', cls: justLeveled ? 'pop' : '' }) : '<span class="none">還沒有等級</span>'}
        <span class="pts num">${p.points}<span class="u">收藏積分</span></span>
      </div>
      <div class="pbar" role="progressbar" aria-label="升到下一級的進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.ratio * 100)}"${p.toNext === null ? ' aria-valuetext="已達最高等級"' : ''}>
        <span class="fill" id="cpFill" data-target="${Math.round(p.ratio * 100)}" style="width:${Math.round(startW * 100)}%"></span>
      </div>
      <p class="hint">${p.toNext !== null ? `還差 <b class="num">${p.toNext}</b> 分升到下一級（${nextName}）。登記一張鑑定卡加 1 分。` : '已達最高等級。'}</p>
      <div class="btns"><button class="btn" type="button" data-go="rules">等級規則</button><button class="btn" type="button" data-book="${ME}">我的公開卡冊</button></div>
    </section>

    ${lvup}

    <div class="sim" aria-label="示意控制">
      <div class="t"><b>示意：模擬加 1 分／扣 1 分</b>　正式網站沒有這些按鈕，只是讓你看等級怎麼變。</div>
      <div class="btns3">
        <button class="btn" type="button" data-sim="1">加 1 分</button>
        <button class="btn" type="button" data-sim="-1">扣 1 分</button>
        <button class="btn" type="button" data-sim="reset">重設</button>
      </div>
    </div>

    <section class="sec"><div class="sechead"><h3>積分紀錄</h3><small>新到舊 · 示意</small></div>
      <div class="list ledger">${rows}<div class="older">更早的 <span class="num">${olderCount}</span> 筆紀錄，合計 <span class="num">${olderSum >= 0 ? '+' : '−'}${Math.abs(olderSum)}</span> 分（省略）</div></div>
    </section>

    <section class="card pack" aria-label="兌換卡包（草案）">
      <div class="sechead"><h3 style="margin:0;font-size:14px">兌換卡包</h3><span class="draftTag">草案，門檻研究中</span></div>
      <div class="note">${esc(PACK_NOTE)}</div>
      <div class="big">${redeem.firstUsed ? `每 <span class="num">${PACK_COST}</span> 分換一包` : `第一包 <span class="num">${PACK_FIRST_COST}</span> 分，之後每 <span class="num">${PACK_COST}</span> 分一包`}</div>
      <dl class="kv">
        <div><dt>等級分</dt><dd><span class="num">${pts}</span> 分　決定徽章，兌換不會扣</dd></div>
        <div><dt>可兌換額度</dt><dd><b class="num">${redeem.confirmed}</b> 分　照片確認過、滿 ${PACK_COOLDOWN_DAYS} 天、沒被檢舉</dd></div>
        <div><dt>還不能用</dt><dd>冷卻中 <span class="num">${redeem.cooling}</span> 張、照片審核中 <span class="num">${redeem.reviewing}</span> 張</dd></div>
        <div><dt>本季</dt><dd>已換 <span class="num">${redeem.quarterUsed}</span> / ${PACK_PER_QUARTER} 包</dd></div>
      </dl>
      <div class="cnt">${packStatus}</div>
      <p class="hint">等級分比額度高是正常的：站內買卡的分、還在冷卻或審核的登記，都算等級但不算額度。</p>
      <button class="btn primary" type="button" data-redeem="1"${canRedeem ? '' : ' aria-disabled="true"'}>${canRedeem ? `用 ${cost} 分兌換一包（示意）` : '還不能兌換'}</button>
      <button class="btn" type="button" data-go="rules" style="margin-top:8px">看兌換規則</button>
    </section>`;
}

/* ---------- 畫面：等級規則 ---------- */
function rules() {
  const myLv = levelFor(mePoints());
  const table = `<div class="lvRow"><span class="zero">0 級：不顯示徽章</span><span class="th"><b>0</b> 分</span></div>` +
    COLLECTOR_LEVELS.map(d => `<div class="lvRow${d.level === myLv ? ' me' : ''}">${badge(d.level, { size: 'md' })}<span class="th"><b>${d.min}</b> 分起${d.level === myLv ? '<br>你在這級' : ''}</span></div>`).join('');
  return `<div class="head" style="grid-template-columns:1fr"><div><h3 style="font-size:17px">收藏家等級規則</h3><div class="sub">以 2026-09-15 設計文件為準 · 分數與等級名稱都還可能調整</div></div></div>

    <section class="card rules"><h3>收藏積分是什麼</h3>
      <p>決定等級的分數。跟錢包裡的點數是兩回事：不能花、不能轉讓。正式規則目前是<b style="color:var(--ink)">不能兌換任何東西</b>；「我的」頁的兌換卡包只是草案。</p></section>

    <section class="card rules"><h3>怎麼加分</h3><ul>
      <li><b>登記一張有鑑定編號的卡：+1。</b>登記成功就入帳，加給登記的人。</li>
      <li><b>在站內市場買到一張卡：+1。</b>買家確認收貨、或鑑賞期過了，才入帳。</li>
      <li><b>不加分：</b>沒有鑑定編號的裸卡、玩家之間互換、當賣家賣出、抽卡抽到的卡。</li>
    </ul></section>

    <section class="card rules"><h3>什麼時候扣回</h3><ul>
      <li><b>登記的編號被檢舉成立：−1，</b>扣當初登記的人，抵銷那 1 分。</li>
      <li><b>買卡的訂單最後退款或取消：−1，</b>扣買家；如果那 1 分還沒入帳，就沒有分可扣。</li>
      <li><b>自己刪除登記：−1。</b></li>
      <li>同一件事只會加一次、扣一次；沒加過分的事不會扣分。總分最低是 0。</li>
    </ul></section>

    <section class="card rules"><h3>卡賣掉不扣分</h3>
      <p>等級看的是你登記過、買過多少張，不看卡冊裡現在還剩幾張。把卡賣掉或轉給別人，分數都不會少。</p></section>

    <section class="card rules"><h3>五個等級</h3><div class="lvTable">${table}</div>
      <p>等級名稱刻意不用寶可夢的官方用語，避免被誤會成官方授權。</p></section>

    <div class="note"><b>第一階段還沒有站內交易，</b>所以實際上只有「登記鑑定卡」和它的扣回會發生。</div>

    <div class="head" style="grid-template-columns:1fr;margin-top:6px"><div><h3 style="font-size:17px">兌換卡包規則</h3><div class="sub"><span class="draftTag">草案</span>　正式規則仍是不能兌換，確定要做才會改規格</div></div></div>

    <section class="card rules"><h3>門檻</h3><ul>
      <li><b>第一包 ${PACK_FIRST_COST} 分，</b>每支手機號碼只有一次。一般玩家手上鑑定卡的中位數估計約 5 張，登記 10 張就拿得到。</li>
      <li><b>之後每 ${PACK_COST} 分一包，</b>換的是繁中擴充包（官方建議售價約 NT$49～54）。</li>
      <li>門檻是用公開總量反推的估計，開放登記一個月後會用站上實際的登記張數重算。</li>
    </ul></section>

    <section class="card rules"><h3>等級分和可兌換額度是兩個數字</h3><ul>
      <li><b>等級分</b>決定徽章，照前面的加分、扣回規則算，換卡包不會扣。</li>
      <li><b>可兌換額度</b>只算照片經人工確認、登記滿 ${PACK_COOLDOWN_DAYS} 天、而且沒被檢舉的鑑定卡。</li>
      <li><b>第一階段只算登記。</b>站內買卡的分，要等站內付款能驗證之後才算進額度——自己跟自己買賣就能刷成交分。</li>
      <li>換一包就從額度扣掉那一包的分數。</li>
    </ul></section>

    <section class="card rules"><h3>怎麼確認一張登記是真的</h3><ul>
      <li>上傳卡片正面、鑑定標籤，以及和手寫紙條（寫上帳號與日期）的合照。</li>
      <li>人工對照 PSA 官網上這個編號的資料與官方圖片。</li>
      <li>確認前、冷卻期內，這張卡的分數只算等級，不算額度。</li>
    </ul></section>

    <section class="card rules"><h3>限制</h3><ul>
      <li>每個帳號每季最多 ${PACK_PER_QUARTER} 包；同一個收件地址或電話每期 1 包。</li>
      <li>兌換前要先做手機驗證，一人一個帳號。</li>
      <li>每期兌換的總數量會先公告，換完就等下一期。</li>
      <li>寄送只收需要的資料（收件人、電話、地址），不收身分證字號。</li>
    </ul></section>

    <section class="card rules"><h3>換完之後才發現造假</h3><ul>
      <li>這張卡的額度記成負數，帳號凍結兌換，直到補回為止。</li>
      <li>不會向對方追討金錢。</li>
    </ul></section>

    <section class="card rules"><h3>平台一定不做的事</h3><ul>
      ${PACK_NEVER.map(r => `<li>${esc(r)}</li>`).join('')}
    </ul>
      <p>這三件事會讓積分跟錢扯上關係，法律上就可能被認為有「對價」，變成賭博的問題。卡包的內容是隨機的，但只要取得積分完全不用付錢，就比較像贈品而不是抽獎。</p></section>

    <div class="note"><b>還要請律師確認：</b>公平法對低價贈品有 50 元上限，一包 NT$54 多了 4 元；如果「登記卡片」被認定是在招攬交易，可能略為超過。可以改換建議售價 50 元以下的包，或請律師判斷是否適用。</div>`;
}

/* ---------- 畫面：公開卡冊（示意） ---------- */
function book() {
  const who = st.owner;
  const lv = levelFor(pointsOf(who));
  const items = [['zard', 'PSA 10', '84440012'], ['tera', 'PSA 10', '84120031'], ['umbreon', 'PSA 9', '84501220'], ['pika', 'PSA 10', '82231907']];
  return `<div class="bookHead"><span class="avatar" aria-hidden="true"></span><div style="min-width:0">
      <h3>${esc(who)} 的公開卡冊</h3>
      ${lv ? badge(lv, { size: 'md' }) : '<span class="sub">還沒有收藏家等級</span>'}</div></div>
    <div class="note"><b>示意頁：</b>卡冊內容是假的。這個位置正式上線時就是公開卡冊頁首（賣家頁的名稱旁邊也放同一個徽章）。</div>
    <div class="grid2">${items.map(([id, g, no]) => `<div class="bcard"><div class="slab" aria-hidden="true"><i></i><u class="${CARDS[id].th}"></u></div><div class="nm">${CARDS[id].name}</div><span class="grade">${g} · #${no}</span></div>`).join('')}</div>
    <button class="btn" type="button" data-toast="示意：這裡會打開「${esc(who)}」的賣家頁，名稱旁邊同樣有徽章">看賣家頁</button>`;
}

function activeTab() {
  if (MAIN.includes(st.view)) return st.view;
  if (st.view === 'rules') return 'me';
  for (let i = stack.length - 1; i >= 0; i--) if (MAIN.includes(stack[i].view)) return stack[i].view;
  return null;
}
function render() {
  const V = { home, cert, card, me, rules, book };
  screen.innerHTML = V[st.view]();
  const tab = activeTab();
  document.querySelectorAll('.tabbar button').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
  $('#backBtn').hidden = stack.length === 0;
  bindSearch();
  const fill = $('#cpFill');
  if (fill) {
    const target = Number(fill.dataset.target);
    void fill.offsetWidth;
    requestAnimationFrame(() => { fill.style.width = target + '%'; });
    shownRatio = target / 100;
  }
  justLeveled = false;
}

/* ---------- 模擬加減分 ---------- */
function simAdd(delta) {
  const before = levelFor(mePoints());
  if (delta < 0 && mePoints() === 0) { toast('總分最低是 0，不能再扣（示意）'); return false; }
  ledger.unshift({ date: '2026-09-15', delta, reason: delta > 0 ? '示意：模擬加 1 分' : '示意：模擬扣 1 分', card: null, sim: true });
  const after = levelFor(mePoints());
  if (after > before) {
    st.lvup = after; justLeveled = true;
    toast(`升級了：${after} 級「${levelName(after)}」（示意）`);
  } else if (after < before) {
    st.lvup = null;
    toast(after ? `降回 ${after} 級「${levelName(after)}」（示意）` : '分數回到 0，徽章先收起來（示意）');
  }
  if (['me', 'rules'].includes(st.view)) render();
  return after > before;
}
function stopSim() { clearInterval(simTimer); simTimer = null; }
function runLevelUp() {
  stopSim();
  stack.length = 0; Object.assign(st, { view: 'me', q: '', open: null, lvup: null });
  render(); screen.scrollTop = 0;
  const p = progress(mePoints());
  if (p.toNext === null) { toast('已經是最高等級（示意）。先按「重設」再試一次。'); return; }
  if (reduceMotion()) { for (let i = 0; i < p.toNext; i++) simAdd(1); return; }
  const every = Math.max(30, Math.min(320, 2000 / p.toNext));
  simTimer = setInterval(() => {
    if (st.view !== 'me') return stopSim();
    if (simAdd(1)) stopSim();
  }, every);
}

/* ---------- 搜尋 ---------- */
function runQuery(q) {
  const raw = q.trim();
  const digits = raw.replace(/^psa\s*/i, '').replace(/[#\s]/g, '');
  if (/^\d{6,}$/.test(digits)) return go({ view: 'cert', cert: digits, q: '' });
  const hit = Object.entries(CARDS).find(([, c]) => raw && c.name.includes(raw));
  if (hit) return go({ view: 'card', card: hit[0], grade: 'PSA 10', q: '' });
  if (raw) toast(`示意資料裡沒有「${raw}」，試試：噴火龍、太樂巴戈斯、84120031`);
}
function bindSearch() {
  const input = $('#q'); const sug = $('#sug');
  if (!input) return;
  const draw = () => {
    const v = input.value.trim(); st.q = input.value;
    if (!v) { sug.hidden = true; return; }
    const digits = v.replace(/^psa\s*/i, '').replace(/[#\s]/g, '');
    let items = [];
    if (/^\d+$/.test(digits)) items = [`<button type="button" data-cert="${esc(digits)}"><span class="s1 num">查編號 #${esc(digits)}</span><span class="s2">看有沒有人登記</span></button>`];
    else items = Object.entries(CARDS).filter(([, c]) => c.name.includes(v)).map(([id, c]) => `<button type="button" data-card="${id}" data-grade="PSA 10"><span class="s1">${c.name}</span><span class="s2">${c.set}</span></button>`);
    sug.innerHTML = items.join('') || `<button type="button" disabled><span class="s2">示意資料裡找不到「${esc(v)}」</span></button>`;
    sug.hidden = false;
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runQuery(input.value); } });
  if (st.q) draw();
}

/* ---------- 點擊 ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t || t.disabled) return;
  if (t.id === 'backBtn') { stopSim(); return back(); }
  if (t.dataset.try) {
    const v = t.dataset.try;
    if (v === 'lvup') return runLevelUp();
    stopSim();
    stack.length = 0; Object.assign(st, { view: 'home', q: '' });
    return runQuery(v);
  }
  if (t.dataset.tab) { stopSim(); stack.length = 0; Object.assign(st, { view: t.dataset.tab, open: null, q: '', lvup: null }); render(); screen.scrollTop = 0; return; }
  if (t.dataset.range) { st.range = Number(t.dataset.range); return render(); }
  if (t.dataset.toast) return toast(t.dataset.toast);
  if (t.dataset.sim) {
    stopSim();
    if (t.dataset.sim === 'reset') { ledger = LEDGER_INIT.map(x => ({ ...x })); redeem = { ...REDEEM_INIT }; st.lvup = null; render(); return toast(`已重設為 ${mePoints()} 分（示意）`); }
    return simAdd(Number(t.dataset.sim));
  }
  if (t.dataset.redeem) {
    const cost = nextPackCost();
    if (redeem.quarterUsed >= PACK_PER_QUARTER) return toast(`這一季已經換過 ${PACK_PER_QUARTER} 包了，下一季才能再換（示意）。`);
    if (redeem.confirmed < cost) return toast(`可兌換額度還差 ${cost - redeem.confirmed} 分。冷卻中或審核中的卡還不算（示意）。`);
    const lvBefore = levelFor(mePoints());
    redeem.confirmed -= cost; redeem.firstUsed = true; redeem.quarterUsed += 1;
    render();
    return toast(`示意：扣掉 ${cost} 分額度，換到一包。等級分沒變，還是 ${lvBefore} 級。`);
  }
  if (t.dataset.go) { stopSim(); return go({ view: t.dataset.go }); }
  if (t.dataset.book) { stopSim(); return go({ view: 'book', owner: t.dataset.book }); }
  if (t.dataset.cert) return go({ view: 'cert', cert: t.dataset.cert, q: '' });
  if (t.dataset.gradeTab) { st.grade = t.dataset.gradeTab; st.open = null; return render(); }
  if (t.dataset.toggle) { st.open = st.open === t.dataset.toggle ? null : t.dataset.toggle; return render(); }
  if (t.dataset.card) return go({ view: 'card', card: t.dataset.card, grade: t.dataset.grade || 'PSA 10', q: '', open: t.dataset.open || null });
});
document.addEventListener('click', e => {
  const sug = $('#sug'); if (sug && !e.target.closest('.searchBox')) sug.hidden = true;
});

render();
