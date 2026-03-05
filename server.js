const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// -------------------- axios --------------------
const http = axios.create({
  timeout: 20000,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

// -------------------- CORS --------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------- helpers --------------------
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
function mkKey(parts) {
  return parts.map((x) => String(x ?? "")).join("|");
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampInt(v, a, b) {
  const n = Number(v);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, Math.trunc(n)));
}

// безопасно достаём вложенные значения по пути "a.b.c"
function getPath(obj, path) {
  if (!obj) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

// ищем первое числовое значение среди вариантов путей
function pickNumber(obj, paths, fallback = 0) {
  for (const p of paths) {
    const v = getPath(obj, p);
    const n = num(v);
    if (n !== null) return n;
  }
  return fallback;
}

// ищем дату для точки графика
function pickDate(item) {
  const candidates = ["date", "day", "period", "periodDay", "dt", "dateFrom", "dateTo"];
  for (const k of candidates) {
    const v = item?.[k];
    if (typeof v === "string" && v.length >= 8) return v.slice(0, 10);
  }
  return null;
}

// -------------------- health --------------------
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// -------------------- token cache --------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) return tokenCache.token;

  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
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

// -------------------- marketing cache (TTL 10m) --------------------
const marketingCache = new Map();
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

// -------------------- CM marketing fetch --------------------
async function fetchMarketingRaw({ token, dealerId, startDate, endDate, siteSource = null }) {
  const dealerIdNum = Number(dealerId);
  if (!Number.isFinite(dealerIdNum)) {
    const err = new Error("Invalid dealerId (must be a number)");
    err.status = 400;
    throw err;
  }

  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";
  const body = {
    grouping: "periodDay",
    dealerIds: [dealerIdNum],
    siteSource,
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

// -------------------- normalize CM marketing response --------------------
// делаем “устойчивый” парсер: если у CM.Expert поля названы иначе — всё равно соберём цифры.
function normalizeMarketing(raw) {
  // некоторые API кладут данные в raw.data — учтём
  const root = raw?.data && (raw.total || raw.stats) == null ? raw.data : raw;

  const totalSrc = root?.total ?? root ?? {};

  // просмотры
  const views = pickNumber(totalSrc, [
    "views",
    "viewsCount",
    "viewCount",
    "impressions",
    "impressionsCount",
    "shows",
    "showsCount",
  ], 0);

  // звонки (часто именно они “есть”, а чаты нет)
  const callsTotal = pickNumber(totalSrc, [
    "calls.total",
    "callsTotal",
    "call.total",
    "callTotal",
    "callsCount",
    "callCount",
    "phoneCalls",
    "phoneCallsCount",
  ], 0);

  const callsMissed = pickNumber(totalSrc, [
    "calls.missed",
    "callsMissed",
    "call.missed",
    "callMissed",
    "missedCalls",
    "missedCallsCount",
  ], 0);

  // чаты
  const chatsTotal = pickNumber(totalSrc, [
    "chats.total",
    "chatsTotal",
    "chat.total",
    "chatTotal",
    "chatsCount",
    "chatCount",
  ], 0);

  const chatsMissed = pickNumber(totalSrc, [
    "chats.missed",
    "chatsMissed",
    "chat.missed",
    "chatMissed",
  ], 0);

  const chatsPaid = pickNumber(totalSrc, [
    "chats.targeted",
    "chats.paid",
    "chatsPaid",
    "paidChats",
    "targetedChats",
  ], 0);

  // расходы
  const sumExpenses = pickNumber(totalSrc, ["sumExpenses", "expenses", "totalExpenses"], 0);
  const sumWithBonusesExpenses = pickNumber(totalSrc, ["sumWithBonusesExpenses", "expensesWithBonuses"], sumExpenses);

  const placementExpenses = pickNumber(totalSrc, ["placementExpenses", "placementsExpenses"], 0);
  const callsExpenses = pickNumber(totalSrc, ["callsExpenses", "callExpenses", "phoneCallsExpenses"], 0);
  const chatsExpenses = pickNumber(totalSrc, ["chatsExpenses", "chatExpenses"], 0);
  const tariffsExpenses = pickNumber(totalSrc, ["tariffsExpenses", "tariffExpenses"], 0);

  // stats (по дням)
  const statsSrc = Array.isArray(root?.stats) ? root.stats : Array.isArray(root?.items) ? root.items : [];
  const stats = statsSrc
    .map((it) => {
      const date = pickDate(it);
      if (!date) return null;

      const vViews = pickNumber(it, ["views", "viewsCount", "impressions", "shows"], 0);
      const vCalls = pickNumber(it, ["calls.total", "callsTotal", "callsCount", "phoneCalls"], 0);
      const vChats = pickNumber(it, ["chats.total", "chatsTotal", "chatsCount"], 0);

      return {
        date,
        views: vViews,
        calls: { total: vCalls },
        chats: { total: vChats },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    ok: true,
    total: {
      views,
      calls: { total: callsTotal, missed: callsMissed },
      chats: { total: chatsTotal, missed: chatsMissed, paid: chatsPaid },
      sumExpenses,
      sumWithBonusesExpenses,
      placementExpenses,
      callsExpenses,
      chatsExpenses,
      tariffsExpenses,
    },
    stats,
  };
}

// -------------------- UI --------------------
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
.container{max-width:1100px;margin:40px auto;padding:0 16px;}
h1{font-size:38px;margin:0;letter-spacing:-.02em}
.sub{margin:8px 0 0;color:var(--muted);font-size:14px}
.card{
  background:var(--card);
  border:1px solid rgba(229,231,235,.8);
  border-radius:18px;
  padding:18px;
  box-shadow:0 14px 40px rgba(15,23,42,.06);
  margin-top:16px;
}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.input{
  flex:1;min-width:260px;
  padding:14px 14px;border-radius:12px;border:1px solid var(--border);
  outline:none;font-size:16px;background:#fff;
}
.btn{padding:12px 14px;border-radius:12px;border:none;font-weight:800;cursor:pointer;}
.btn-primary{background:var(--accent);color:#fff}
.btn-ghost{background:#f3f4f6;color:#111827}
.btn:disabled{opacity:.6;cursor:not-allowed}

.sectionTitle{margin:18px 0 10px;font-size:18px;letter-spacing:-.01em}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;}
.kpi{
  grid-column:span 3;
  background:linear-gradient(180deg,#ffffff 0%, #fafafa 100%);
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
}
.kpi .label{color:var(--muted);font-size:12px;margin-bottom:6px}
.kpi .value{font-size:22px;font-weight:900}
@media(max-width:900px){.kpi{grid-column:span 6}}
@media(max-width:560px){.kpi{grid-column:span 12}h1{font-size:30px}}

.split{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.panel{border:1px solid rgba(229,231,235,.9);border-radius:16px;padding:14px;background:#fff;}
.muted{color:var(--muted);font-size:14px}
.error{background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:12px 14px;border-radius:14px;}
.sourceGrid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;}
.sourceCard{grid-column:span 4;border:1px solid rgba(229,231,235,.9);border-radius:16px;padding:14px;background:#fff;}
@media(max-width:900px){.sourceCard{grid-column:span 6}}
@media(max-width:560px){.sourceCard{grid-column:span 12}}
hr.sep{border:0;height:1px;background:rgba(229,231,235,.9);margin:16px 0;}
</style>
</head>
<body>
<div class="container">
  <div>
    <h1>Проверка автомобиля по VIN</h1>
    <div class="sub">Маркетинг — последние <b>30 дней</b>. Показываем <b>звонки</b>, <b>чаты</b> и <b>лиды</b>.</div>
  </div>

  <div class="card">
    <div class="row">
      <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17" />
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
      <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
    </div>
    <div class="muted" style="margin-top:10px">Период маркетинга фиксированный: последние 30 дней.</div>
  </div>

  <div id="out"></div>
</div>

<script>
let current = { dealerId: null };
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
  const calls = t.calls || {};
  const chats = t.chats || {};
  const leads = (Number(calls.total||0) + Number(chats.total||0));
  const period = m.period || {};

  const src = (key, title) => {
    const x = m.bySource?.[key]?.total;
    const xc = x?.calls || {};
    const xh = x?.chats || {};
    const xLeads = (Number(xc.total||0) + Number(xh.total||0));
    return \`
      <div class="sourceCard">
        <div style="font-weight:900; font-size:16px">\${esc(title)}</div>
        <div class="muted" style="margin-top:8px">Просмотры: <b>\${fmtNum(x?.views)}</b></div>
        <div class="muted">Звонки: <b>\${fmtNum(xc?.total)}</b></div>
        <div class="muted">Чаты: <b>\${fmtNum(xh?.total)}</b></div>
        <div class="muted">Лиды: <b>\${fmtNum(xLeads)}</b></div>
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
        <div class="label">Звонки (всего / пропущено)</div>
        <div class="value" style="font-size:18px">\${fmtNum(calls.total)} / \${fmtNum(calls.missed)}</div>
      </div>
      <div class="kpi">
        <div class="label">Чаты (всего / пропущено / платные)</div>
        <div class="value" style="font-size:18px">\${fmtNum(chats.total)} / \${fmtNum(chats.missed)} / \${fmtNum(chats.paid)}</div>
      </div>
      <div class="kpi">
        <div class="label">Лиды (звонки + чаты)</div>
        <div class="value">\${fmtNum(leads)}</div>
      </div>

      <div class="kpi">
        <div class="label">Расходы всего (с бонусами)</div>
        <div class="value">\${fmtMoney(t.sumWithBonusesExpenses ?? t.sumExpenses)}</div>
      </div>
      <div class="kpi" style="grid-column:span 6">
        <div class="label">Размещение / Звонки / Чаты / Тариф</div>
        <div class="value" style="font-size:16px">
          \${fmtMoney(t.placementExpenses)} / \${fmtMoney(t.callsExpenses)} / \${fmtMoney(t.chatsExpenses)} / \${fmtMoney(t.tariffsExpenses)}
        </div>
      </div>
    </div>

    <div class="split" style="margin-top:14px">
      <div class="panel">
        <div style="font-weight:900; margin-bottom:10px">Динамика: просмотры / звонки / чаты</div>
        <canvas id="chartMain" height="120"></canvas>
      </div>
      <div class="panel">
        <div style="font-weight:900; margin-bottom:10px">Лиды по источникам</div>
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
  const calls = stats.map(x => Number(x.calls?.total||0));
  const chats = stats.map(x => Number(x.chats?.total||0));

  const ctx1 = document.getElementById("chartMain").getContext("2d");
  if(chartMain) chartMain.destroy();
  chartMain = new Chart(ctx1, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Просмотры", data: views, tension: 0.25 },
        { label: "Звонки", data: calls, tension: 0.25 },
        { label: "Чаты", data: chats, tension: 0.25 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { x: { ticks: { maxRotation: 0 } } }
    }
  });

  const srcKeys = ["auto.ru","avito.ru","drom.ru"];
  const srcLabels = ["auto.ru","avito.ru","drom.ru"];
  const leads = srcKeys.map(k => {
    const t = m.bySource?.[k]?.total || {};
    const c = t.calls?.total || 0;
    const h = t.chats?.total || 0;
    return Number(c) + Number(h);
  });

  const ctx2 = document.getElementById("chartSources").getContext("2d");
  if(chartSources) chartSources.destroy();
  chartSources = new Chart(ctx2, {
    type: "bar",
    data: {
      labels: srcLabels,
      datasets: [{ label: "Лиды (звонки+чаты)", data: leads }]
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

  holder.innerHTML = '<div class="muted">Загружаем маркетинг за последние 30 дней…</div>';

  try{
    const r = await fetch('/marketing?dealerId=' + encodeURIComponent(current.dealerId));
    const data = await r.json();

    if(!r.ok || !data?.ok){
      holder.innerHTML = '<div class="error">' + esc(data?.message || 'Маркетинг не удалось получить') + '</div>';
      return;
    }

    holder.innerHTML = renderMarketing(data.marketing);
    drawCharts(data.marketing);
  }catch(e){
    holder.innerHTML = '<div class="error">Маркетинг недоступен: ' + esc(e.message) + '</div>';
  }
}
</script>
</body>
</html>`);
});

// -------------------- /check-vin --------------------
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
      dealerId: c.dealerId ?? null,
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || "VIN request failed";
    return res.status(status).json({ ok: false, message: msg, status });
  }
});

// -------------------- /marketing (last 30 days, robust parsing) --------------------
app.get("/marketing", async (req, res) => {
  const dealerIdRaw = String(req.query.dealerId || "").trim();
  if (!dealerIdRaw) return res.status(400).json({ ok: false, message: "dealerId is required" });

  const dealerId = Number(dealerIdRaw);
  if (!Number.isFinite(dealerId)) {
    return res.status(400).json({ ok: false, message: "dealerId must be a number" });
  }

  const endDate = toISODate(new Date());
  const startDate = toISODate(addDays(new Date(), -30));

  const cacheKey = mkKey(["mkt30_norm", dealerId, startDate, endDate]);
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ok: true, cached: true, marketing: cached });

  try {
    const token = await getToken();

    const sources = ["auto.ru", "avito.ru", "drom.ru"];
    const tasks = [
      fetchMarketingRaw({ token, dealerId, startDate, endDate, siteSource: null }),
      ...sources.map((s) => fetchMarketingRaw({ token, dealerId, startDate, endDate, siteSource: s })),
    ];

    const results = await Promise.allSettled(tasks);

    const baseRaw = results[0].status === "fulfilled" ? results[0].value : null;
    if (!baseRaw) {
      const err = results[0].reason;
      const status = err?.response?.status || 500;
      const msg = err?.response?.data?.message || err?.message || "Marketing request failed";
      return res.status(502).json({ ok: false, message: msg, status });
    }

    const base = normalizeMarketing(baseRaw);

    const bySource = {};
    sources.forEach((s, idx) => {
      const rr = results[idx + 1];
      if (rr.status === "fulfilled") {
        bySource[s] = normalizeMarketing(rr.value);
      } else {
        bySource[s] = { ok: false, message: "source failed" };
      }
    });

    const marketing = {
      ok: true,
      grouping: "periodDay",
      period: { startDate, endDate, days: 30 },
      total: base.total,
      stats: base.stats,
      bySource,
    };

    cacheSet(cacheKey, marketing, 10 * 60 * 1000);
    return res.json({ ok: true, cached: false, marketing });
  } catch (e) {
    const status = e?.response?.status || 500;
    const msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || "Marketing request failed";
    return res.status(status).json({ ok: false, message: msg, status });
  }
});

// -------------------- hardening --------------------
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

// -------------------- start --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
