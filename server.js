const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ---------- axios ----------
const http = axios.create({
  timeout: 20000,
  // полезно для Railway/прокси
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- helpers ----------
function toISODate(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ---------- health ----------
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- token cache ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();

  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) {
    return tokenCache.token;
  }

  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // важно: не крашим сервер, а даём понятную ошибку
    const err = new Error("Missing CLIENT_ID or CLIENT_SECRET env vars");
    err.status = 500;
    throw err;
  }

  const r = await http.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = r.data?.access_token;
  const expiresIn = Number(r.data?.expires_in || 3600);

  tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

// ---------- marketing cache (TTL) ----------
const marketingCache = new Map();
function mkKey(parts) {
  return parts.map((x) => String(x ?? "")).join("|");
}
function cacheGet(key) {
  const hit = marketingCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    marketingCache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  marketingCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ---------- marketing API ----------
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";
  const body = {
    grouping: "periodDay",
    dealerIds: [dealerId],
    siteSource, // null / 'auto.ru' / 'avito.ru' / 'drom.ru'
    startDate,
    endDate,
  };

  const r = await http.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return r.data;
}

// суммирование total (на случай days=90 из 3 кусков)
function sumTotals(a, b) {
  const out = { ...(a || {}) };
  out.views = (a?.views || 0) + (b?.views || 0);

  const ac = a?.chats || {};
  const bc = b?.chats || {};
  out.chats = {
    total: (ac.total || 0) + (bc.total || 0),
    missed: (ac.missed || 0) + (bc.missed || 0),
    targeted: (ac.targeted || 0) + (bc.targeted || 0),
  };

  const fields = [
    "sumExpenses",
    "sumWithBonusesExpenses",
    "placementExpenses",
    "callsExpenses",
    "chatsExpenses",
    "tariffsExpenses",
  ];
  for (const f of fields) out[f] = (a?.[f] || 0) + (b?.[f] || 0);

  return out;
}

// объединение stats по дате (если даты пересекутся)
function mergeStats(statsArr) {
  const m = new Map(); // date -> item
  for (const it of statsArr || []) {
    const date = it?.date;
    if (!date) continue;
    const prev = m.get(date);
    if (!prev) {
      m.set(date, JSON.parse(JSON.stringify(it)));
    } else {
      // суммируем основные метрики
      prev.views = (prev.views || 0) + (it.views || 0);
      prev.sumExpenses = (prev.sumExpenses || 0) + (it.sumExpenses || 0);
      prev.sumWithBonusesExpenses = (prev.sumWithBonusesExpenses || 0) + (it.sumWithBonusesExpenses || 0);

      const pc = prev.chats || {};
      const ic = it.chats || {};
      prev.chats = {
        total: (pc.total || 0) + (ic.total || 0),
        missed: (pc.missed || 0) + (ic.missed || 0),
        targeted: (pc.targeted || 0) + (ic.targeted || 0),
      };
    }
  }
  // сортировка по дате
  return Array.from(m.values()).sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

async function getMarketingBundle({ token, dealerId, days }) {
  // days: 7/30/90
  days = clamp(Number(days || 30), 1, 90);

  // период разбиваем по 30 дней (ограничение API)
  const today = new Date();
  const chunks = [];
  if (days <= 30) {
    chunks.push({ startDate: toISODate(addDays(today, -days)), endDate: toISODate(today) });
  } else {
    // 90 = 3 чанка
    chunks.push({ startDate: toISODate(addDays(today, -30)), endDate: toISODate(today) });
    chunks.push({ startDate: toISODate(addDays(today, -60)), endDate: toISODate(addDays(today, -30)) });
    chunks.push({ startDate: toISODate(addDays(today, -90)), endDate: toISODate(addDays(today, -60)) });
  }

  const sources = ["auto.ru", "avito.ru", "drom.ru"];

  // для каждого чанка: 1 базовый + 3 источника (параллельно)
  let total = null;
  let statsAll = [];
  const bySourceTotals = { "auto.ru": null, "avito.ru": null, "drom.ru": null };
  const bySourceStats = { "auto.ru": [], "avito.ru": [], "drom.ru": [] };

  for (const ch of chunks) {
    const tasks = [
      fetchMarketing({ token, dealerId, ...ch, siteSource: null }),
      ...sources.map((s) => fetchMarketing({ token, dealerId, ...ch, siteSource: s })),
    ];

    const results = await Promise.allSettled(tasks);

    // base
    if (results[0].status === "fulfilled") {
      const base = results[0].value;
      total = sumTotals(total, base?.total || {});
      if (Array.isArray(base?.stats)) statsAll.push(...base.stats);
    }

    // sources
    sources.forEach((s, idx) => {
      const rr = results[idx + 1];
      if (rr.status === "fulfilled") {
        const v = rr.value;
        bySourceTotals[s] = sumTotals(bySourceTotals[s], v?.total || {});
        if (Array.isArray(v?.stats)) bySourceStats[s].push(...v.stats);
      }
    });
  }

  const period = {
    startDate: toISODate(addDays(new Date(), -days)),
    endDate: toISODate(new Date()),
    days,
  };

  const bySource = {};
  for (const s of sources) {
    bySource[s] = {
      ok: true,
      total: bySourceTotals[s],
      stats: mergeStats(bySourceStats[s]),
    };
  }

  return {
    ok: true,
    grouping: "periodDay",
    period,
    total,
    stats: mergeStats(statsAll),
    bySource,
  };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VIN аналитика</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
:root{
  --bg:#f5f6fb;
  --card:#ffffff;
  --muted:#6b7280;
  --text:#0f172a;
  --accent:#ff5a2c;
  --border:#e5e7eb;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  background: radial-gradient(1200px 700px at 20% -10%, #ffe7de 0%, rgba(255,231,222,0) 55%),
              radial-gradient(900px 600px at 90% 0%, #e8efff 0%, rgba(232,239,255,0) 55%),
              var(--bg);
  color:var(--text);
}
.container{
  max-width:1100px;
  margin:40px auto;
  padding:0 16px;
}
.header{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:16px;
  margin-bottom:18px;
}
h1{
  font-size:38px;
  margin:0;
  letter-spacing:-.02em;
}
.sub{
  margin:6px 0 0;
  color:var(--muted);
  font-size:14px;
}
.card{
  background:var(--card);
  border:1px solid rgba(229,231,235,.8);
  border-radius:18px;
  padding:18px;
  box-shadow:0 14px 40px rgba(15,23,42,.06);
}
.row{display:flex; gap:12px; flex-wrap:wrap; align-items:center}
.input{
  flex:1;
  min-width:260px;
  padding:14px 14px;
  border-radius:12px;
  border:1px solid var(--border);
  outline:none;
  font-size:16px;
  background:#fff;
}
.btn{
  padding:12px 14px;
  border-radius:12px;
  border:none;
  font-weight:700;
  cursor:pointer;
}
.btn-primary{background:var(--accent); color:#fff}
.btn-ghost{background:#f3f4f6; color:#111827}
.btn:disabled{opacity:.6; cursor:not-allowed}

.pills{display:flex; gap:8px; flex-wrap:wrap}
.pill{
  padding:9px 12px;
  border-radius:999px;
  border:1px solid var(--border);
  background:#fff;
  cursor:pointer;
  font-weight:700;
  font-size:14px;
}
.pill.active{
  border-color:transparent;
  background:#111827;
  color:#fff;
}

.sectionTitle{
  margin:18px 0 10px;
  font-size:18px;
  letter-spacing:-.01em;
}
.grid{
  display:grid;
  grid-template-columns:repeat(12,1fr);
  gap:12px;
}
.kpi{
  grid-column:span 3;
  background:linear-gradient(180deg,#ffffff 0%, #fafafa 100%);
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
}
.kpi .label{color:var(--muted); font-size:12px; margin-bottom:6px}
.kpi .value{font-size:22px; font-weight:900}
.kpi .hint{color:var(--muted); font-size:12px; margin-top:6px}

@media(max-width:900px){ .kpi{grid-column:span 6} }
@media(max-width:560px){ .kpi{grid-column:span 12} h1{font-size:30px} }

.split{
  display:grid;
  grid-template-columns:1.4fr 1fr;
  gap:12px;
}
@media(max-width:900px){ .split{grid-template-columns:1fr} }

.panel{
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
  background:#fff;
}
.muted{color:var(--muted); font-size:14px}
.error{
  background:#fff1f2;
  border:1px solid #fecdd3;
  color:#9f1239;
  padding:12px 14px;
  border-radius:14px;
}

.sourceGrid{
  display:grid;
  grid-template-columns:repeat(12,1fr);
  gap:12px;
}
.sourceCard{
  grid-column:span 4;
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
  background:#fff;
}
@media(max-width:900px){ .sourceCard{grid-column:span 6} }
@media(max-width:560px){ .sourceCard{grid-column:span 12} }

hr.sep{
  border:0;
  height:1px;
  background:rgba(229,231,235,.9);
  margin:16px 0;
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>Проверка автомобиля по VIN</h1>
      <div class="sub">Авто → CM.Expert API · Маркетинг → marketing-statistics · Графики и фильтр периода</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17" />
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
      <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
    </div>

    <div style="margin-top:12px" class="row">
      <div class="muted">Период маркетинга:</div>
      <div class="pills">
        <button class="pill" data-days="7" onclick="setDays(7)">7 дней</button>
        <button class="pill active" data-days="30" onclick="setDays(30)">30 дней</button>
        <button class="pill" data-days="90" onclick="setDays(90)">90 дней</button>
      </div>
    </div>
  </div>

  <div id="out" style="margin-top:14px"></div>
</div>

<script>
let current = { dealerId: null, days: 30 };
let chartMain = null;
let chartSources = null;

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function fmtNum(x){
  const n = Number(x);
  if(!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU');
}
function fmtMoney(x){
  const n = Number(x);
  if(!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU') + ' ₽';
}
function fmtMileage(x){
  const n = Number(x);
  if(!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU') + ' км';
}

function setDays(days){
  current.days = days;
  document.querySelectorAll(".pill").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.days) === Number(days));
  });
  if(current.dealerId) loadMarketing();
}

function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
  current.dealerId = null;
  if(chartMain){ chartMain.destroy(); chartMain=null; }
  if(chartSources){ chartSources.destroy(); chartSources=null; }
}

function renderCar(data){
  return \`
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap">
      <div>
        <div style="font-size:28px; font-weight:900; letter-spacing:-.02em">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</div>
        <div class="muted" style="margin-top:6px">VIN: <b>\${esc(data.vin)}</b></div>
      </div>
      <div class="muted">dealerId: <b>\${esc(data.dealerId || '—')}</b></div>
    </div>

    <div class="grid" style="margin-top:14px">
      <div class="kpi">
        <div class="label">Комплектация</div>
        <div class="value" style="font-size:18px">\${esc(data.equipmentName || '—')}</div>
      </div>
      <div class="kpi">
        <div class="label">Модификация</div>
        <div class="value" style="font-size:18px">\${esc(data.modificationName || '—')}</div>
      </div>
      <div class="kpi">
        <div class="label">Пробег</div>
        <div class="value">\${esc(fmtMileage(data.mileage))}</div>
      </div>
      <div class="kpi">
        <div class="label">Цвет</div>
        <div class="value" style="font-size:18px">\${esc(data.color || '—')}</div>
      </div>
    </div>

    <hr class="sep"/>
    <div id="marketingBlock" class="muted">Загружаем маркетинг…</div>
  </div>\`;
}

function renderMarketing(m){
  if(!m || !m.ok){
    return \`<div class="error">Маркетинг недоступен: \${esc(m?.message || 'ошибка')}</div>\`;
  }

  const t = m.total || {};
  const chats = t.chats || {};
  const period = m.period || {};

  const src = (key, title) => {
    const x = m.bySource?.[key]?.total;
    const ch = x?.chats || {};
    return \`
      <div class="sourceCard">
        <div style="font-weight:900; font-size:16px">\${esc(title)}</div>
        <div class="muted" style="margin-top:8px">Просмотры: <b>\${fmtNum(x?.views)}</b></div>
        <div class="muted">Чаты: <b>\${fmtNum(ch?.total)}</b></div>
        <div class="muted">Расходы: <b>\${fmtMoney(x?.sumWithBonusesExpenses ?? x?.sumExpenses)}</b></div>
      </div>\`;
  };

  return \`
  <div>
    <div class="sectionTitle">Маркетинговая статистика (\${esc(period.startDate)} — \${esc(period.endDate)})</div>

    <div class="grid">
      <div class="kpi">
        <div class="label">Просмотры</div>
        <div class="value">\${fmtNum(t.views)}</div>
      </div>
      <div class="kpi">
        <div class="label">Чаты (всего / пропущено / платные)</div>
        <div class="value" style="font-size:18px">\${fmtNum(chats.total)} / \${fmtNum(chats.missed)} / \${fmtNum(chats.targeted)}</div>
      </div>
      <div class="kpi">
        <div class="label">Расходы всего (с бонусами)</div>
        <div class="value">\${fmtMoney(t.sumWithBonusesExpenses ?? t.sumExpenses)}</div>
      </div>
      <div class="kpi">
        <div class="label">Размещение / Звонки / Чаты / Тариф</div>
        <div class="value" style="font-size:16px">
          \${fmtMoney(t.placementExpenses)} / \${fmtMoney(t.callsExpenses)} / \${fmtMoney(t.chatsExpenses)} / \${fmtMoney(t.tariffsExpenses)}
        </div>
      </div>
    </div>

    <div class="split" style="margin-top:14px">
      <div class="panel">
        <div style="font-weight:900; margin-bottom:10px">Динамика: просмотры и чаты</div>
        <canvas id="chartMain" height="120"></canvas>
      </div>
      <div class="panel">
        <div style="font-weight:900; margin-bottom:10px">Чаты по источникам</div>
        <canvas id="chartSources" height="120"></canvas>
      </div>
    </div>

    <div class="sectionTitle" style="margin-top:16px">Трафик с классифайдов</div>
    <div class="sourceGrid">
      \${src('auto.ru','auto.ru')}
      \${src('avito.ru','avito.ru')}
      \${src('drom.ru','drom.ru')}
    </div>

    <div class="muted" style="margin-top:10px">Если по источнику пусто — данных нет за период или API не вернул разбивку.</div>
  </div>\`;
}

function drawCharts(m){
  const stats = Array.isArray(m.stats) ? m.stats : [];
  const labels = stats.map(x => x.date);
  const views = stats.map(x => Number(x.views||0));
  const chats = stats.map(x => Number(x.chats?.total||0));

  const ctx1 = document.getElementById("chartMain").getContext("2d");
  if(chartMain) chartMain.destroy();
  chartMain = new Chart(ctx1, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Просмотры", data: views, tension: 0.25 },
        { label: "Чаты", data: chats, tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { x: { ticks: { maxRotation: 0 } } }
    }
  });

  // источники: суммарные чаты
  const srcKeys = ["auto.ru","avito.ru","drom.ru"];
  const srcLabels = ["auto.ru","avito.ru","drom.ru"];
  const srcChats = srcKeys.map(k => Number(m.bySource?.[k]?.total?.chats?.total || 0));

  const ctx2 = document.getElementById("chartSources").getContext("2d");
  if(chartSources) chartSources.destroy();
  chartSources = new Chart(ctx2, {
    type: "bar",
    data: {
      labels: srcLabels,
      datasets: [{ label: "Чаты", data: srcChats }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } }
    }
  });
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML = '<div class="error">Введите VIN</div>'; return; }
  if(vin.length !== 17){ out.innerHTML = '<div class="error">VIN должен быть 17 символов</div>'; return; }

  btn.disabled = true;
  out.innerHTML = '<div class="card muted">Запрос к API…</div>';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();

    if(!r.ok || data?.ok === false){
      out.innerHTML = '<div class="error">' + esc(data?.message || data?.error || 'Ошибка запроса') + '</div>';
      return;
    }

    current.dealerId = data.dealerId || null;
    out.innerHTML = renderCar({ ...data, vin });

    if(current.dealerId){
      loadMarketing();
    }else{
      document.getElementById("marketingBlock").innerHTML = '<div class="error">Нет dealerId — маркетинг не запросить</div>';
    }
  }catch(e){
    out.innerHTML = '<div class="error">Ошибка: ' + esc(e.message) + '</div>';
  }finally{
    btn.disabled = false;
  }
}

async function loadMarketing(){
  const holder = document.getElementById("marketingBlock");
  if(!holder) return;

  holder.innerHTML = '<div class="muted">Загружаем маркетинг за ' + esc(current.days) + ' дней…</div>';

  try{
    const r = await fetch('/marketing?dealerId=' + encodeURIComponent(current.dealerId) + '&days=' + encodeURIComponent(current.days));
    const data = await r.json();

    if(!r.ok || !data?.ok){
      holder.innerHTML = '<div class="error">' + esc(data?.message || 'Маркетинг не удалось получить') + '</div>';
      return;
    }

    holder.innerHTML = renderMarketing(data.marketing);
    // chart canvas теперь в DOM
    drawCharts(data.marketing);
  }catch(e){
    holder.innerHTML = '<div class="error">Маркетинг недоступен: ' + esc(e.message) + '</div>';
  }
}
</script>
</body>
</html>`);
});

// ---------- /check-vin ----------
app.get("/check-vin", async (req, res) => {
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok: false, message: "VIN is required" });

  try {
    const token = await getToken();
    const r = await http.get("https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car", {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    });

    const c = r.data || {};
    return res.json({
      ok: true,
      brand: c.brand,
      model: c.model,
      year: c.year,
      equipmentName: c.equipmentName,
      modificationName: c.modificationName,
      mileage: c.mileage,
      color: c.color,
      dealerId: c.dealerId || null,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const msg = e?.response?.data?.message || e?.message || "VIN request failed";
    return res.status(status).json({ ok: false, message: msg, status });
  }
});

// ---------- /marketing ----------
app.get("/marketing", async (req, res) => {
  const dealerId = String(req.query.dealerId || "").trim();
  const days = clamp(Number(req.query.days || 30), 1, 90);

  if (!dealerId) return res.status(400).json({ ok: false, message: "dealerId is required" });

  const key = mkKey(["mkt", dealerId, days]);
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, cached: true, marketing: cached });

  try {
    const token = await getToken();
    const marketing = await getMarketingBundle({ token, dealerId, days });

    // кэшируем 10 минут если ok, иначе 2 минуты чтобы не долбить API
    cacheSet(key, marketing, marketing.ok ? 10 * 60 * 1000 : 2 * 60 * 1000);

    return res.json({ ok: true, cached: false, marketing });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const msg = e?.response?.data?.message || e?.message || "Marketing request failed";
    return res.status(status).json({ ok: false, message: msg, status });
  }
});

// ---------- hardening: log crashes ----------
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// ---------- start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
