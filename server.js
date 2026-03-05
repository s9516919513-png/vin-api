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

// -------------------- marketing API --------------------
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const dealerIdNum = Number(dealerId);
  if (!Number.isFinite(dealerIdNum)) {
    const err = new Error("Invalid dealerId (must be a number)");
    err.status = 400;
    throw err;
  }

  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping: "periodDay",
    dealerIds: [dealerIdNum], // важно: число
    siteSource, // null / auto.ru / avito.ru / drom.ru
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
.container{
  max-width:1100px;
  margin:40px auto;
  padding:0 16px;
}
h1{font-size:38px; margin:0; letter-spacing:-.02em}
.sub{margin:8px 0 0; color:var(--muted); font-size:14px}
.card{
  background:var(--card);
  border:1px solid rgba(229,231,235,.8);
  border-radius:18px;
  padding:18px;
  box-shadow:0 14px 40px rgba(15,23,42,.06);
  margin-top:16px;
}
.row{display:flex; gap:12px; flex-wrap:wrap; align-items:center}
.input{
  flex:1; min-width:260px;
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
  font-weight:800;
  cursor:pointer;
}
.btn-primary{background:var(--accent); color:#fff}
.btn-ghost{background:#f3f4f6; color:#111827}
.btn:disabled{opacity:.6; cursor:not-allowed}

.sectionTitle{margin:18px 0 10px; font-size:18px; letter-spacing:-.01em}
.grid{display:grid; grid-template-columns:repeat(12,1fr); gap:12px;}
.kpi{
  grid-column:span 3;
  background:linear-gradient(180deg,#ffffff 0%, #fafafa 100%);
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
}
.kpi .label{color:var(--muted); font-size:12px; margin-bottom:6px}
.kpi .value{font-size:22px; font-weight:900}
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

.sourceGrid{display:grid; grid-template-columns:repeat(12,1fr); gap:12px;}
.sourceCard{
  grid-column:span 4;
  border:1px solid rgba(229,231,235,.9);
  border-radius:16px;
  padding:14px;
  background:#fff;
}
@media(max-width:900px){ .sourceCard{grid-column:span 6} }
@media(max-width:560px){ .sourceCard{grid-column:span 12} }

hr.sep{border:0; height:1px; background:rgba(229,231,235,.9); margin:16px 0;}
</style>
</head>
<body>
<div class="container">
  <div>
    <h1>Проверка автомобиля по VIN</h1>
    <div class="sub">Маркетинг показывается за последние <b>30 дней</b> (как в прежней рабочей версии) + графики.</div>
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
    const status = e?.status || e?.response?.status || 500;
    const msg =
      e?.response?.data?.message ||
      e?.response?.data?.error ||
      e?.message ||
      "VIN request failed";
    return res.status(status).json({ ok: false, message: msg, status });
  }
});

// -------------------- /marketing (FIXED 30 days only) --------------------
app.get("/marketing", async (req, res) => {
  const dealerIdRaw = String(req.query.dealerId || "").trim();
  if (!dealerIdRaw) return res.status(400).json({ ok: false, message: "dealerId is required" });

  const dealerId = Number(dealerIdRaw);
  if (!Number.isFinite(dealerId)) {
    return res.status(400).json({ ok: false, message: "dealerId must be a number" });
  }

  // ✅ строго 30 дней одним куском (как в прежней версии)
  const endDate = toISODate(new Date());
  const startDate = toISODate(addDays(new Date(), -30));

  const cacheKey = mkKey(["mkt30", dealerId, startDate, endDate]);
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ok: true, cached: true, marketing: cached });

  try {
    const token = await getToken();

    const sources = ["auto.ru", "avito.ru", "drom.ru"];
    const tasks = [
      fetchMarketing({ token, dealerId, startDate, endDate, siteSource: null }),
      ...sources.map((s) => fetchMarketing({ token, dealerId, startDate, endDate, siteSource: s })),
    ];

    const results = await Promise.allSettled(tasks);

    const base = results[0].status === "fulfilled" ? results[0].value : null;

    if (!base) {
      const err = results[0].reason;
      const status = err?.response?.status || 500;
      const msg = err?.response?.data?.message || err?.message || "Marketing request failed";
      return res.status(502).json({ ok: false, message: msg, status });
    }

    const bySource = {};
    sources.forEach((s, idx) => {
      const rr = results[idx + 1];
      if (rr.status === "fulfilled") {
        bySource[s] = { ok: true, total: rr.value?.total || null, stats: rr.value?.stats || null };
      } else {
        bySource[s] = { ok: false, total: null, stats: null };
      }
    });

    const marketing = {
      ok: true,
      grouping: "periodDay",
      period: { startDate, endDate, days: 30 },
      total: base.total || null,
      stats: base.stats || null,
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
