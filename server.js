const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// 👉 меняй при каждом деплое — так ты точно видишь, что новая версия на проде
const APP_VERSION = "vin-ui-2026-03-05-03";

// -------------------- axios --------------------
const http = axios.create({ timeout: 20000 });

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

// -------------------- token cache --------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) return tokenCache.token;

  const tokenResponse = await http.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = tokenResponse.data.access_token;
  const expiresIn = Number(tokenResponse.data.expires_in || 3600);
  tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

// -------------------- marketing API (как в твоей рабочей версии) --------------------
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";
  const body = {
    grouping: "periodDay",
    dealerIds: [dealerId], // оставляем как было в РАБОЧЕЙ версии
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

  return { ok: true, data: r.data, request: { url, body } };
}

// -------------------- routes --------------------
app.get("/health", (req, res) => {
  res.type("json").send(JSON.stringify({ ok: true, version: APP_VERSION, ts: Date.now() }));
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VIN</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
:root{--bg:#f5f6fb;--card:#fff;--muted:#6b7280;--text:#0f172a;--accent:#ff5a2c;--border:#e5e7eb;}
*{box-sizing:border-box}
body{
  margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);
  background: radial-gradient(1200px 700px at 20% -10%, #ffe7de 0%, rgba(255,231,222,0) 55%),
              radial-gradient(900px 600px at 90% 0%, #e8efff 0%, rgba(232,239,255,0) 55%),
              var(--bg);
}
.container{max-width:1100px;margin:40px auto;padding:0 16px;}
h1{font-size:38px;margin:0;letter-spacing:-.02em}
.sub{margin:8px 0 0;color:var(--muted);font-size:14px}
.card{
  background:var(--card);border:1px solid rgba(229,231,235,.8);border-radius:18px;
  padding:18px;box-shadow:0 14px 40px rgba(15,23,42,.06);margin-top:16px;
}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.input{flex:1;min-width:260px;padding:14px 14px;border-radius:12px;border:1px solid var(--border);outline:none;font-size:16px;background:#fff;}
.btn{padding:12px 14px;border-radius:12px;border:none;font-weight:800;cursor:pointer;}
.btn-primary{background:var(--accent);color:#fff}
.btn-ghost{background:#f3f4f6;color:#111827}
.btn:disabled{opacity:.6;cursor:not-allowed}

.titleRow{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}
.title{font-size:30px;font-weight:900;letter-spacing:-.02em;margin:0}
.muted{color:var(--muted);font-size:14px}

.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;margin-top:14px}
.kpi{grid-column:span 3;background:linear-gradient(180deg,#fff 0%, #fafafa 100%);border:1px solid rgba(229,231,235,.9);border-radius:16px;padding:14px;}
.kpi .label{color:var(--muted);font-size:12px;margin-bottom:6px}
.kpi .value{font-size:20px;font-weight:900}
@media(max-width:900px){.kpi{grid-column:span 6}}
@media(max-width:560px){.kpi{grid-column:span 12} h1{font-size:30px}}

.sectionTitle{margin:18px 0 10px;font-size:18px;letter-spacing:-.01em}
.error{background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:12px 14px;border-radius:14px;}
.details{margin-top:8px;color:#991b1b;font-size:12px;white-space:pre-wrap}
hr.sep{border:0;height:1px;background:rgba(229,231,235,.9);margin:16px 0;}
.split{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin-top:12px}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.panel{border:1px solid rgba(229,231,235,.9);border-radius:16px;padding:14px;background:#fff;}
.sourceGrid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.sourceCard{grid-column:span 4;border:1px solid rgba(229,231,235,.9);border-radius:16px;padding:14px;background:#fff;}
@media(max-width:900px){.sourceCard{grid-column:span 6}}
@media(max-width:560px){.sourceCard{grid-column:span 12}}
.sourceCard .name{font-weight:900;font-size:16px;margin-bottom:8px}
.footer{margin:14px 0 0;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<div class="container">
  <div>
    <h1>Проверка автомобиля по VIN</h1>
    <div class="sub">Если сервер вернул HTML вместо JSON — покажем кусок ответа (и это НЕ упадёт).</div>
  </div>

  <div class="card">
    <div class="row">
      <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
      <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
    </div>
    <div class="footer">version: <b>${APP_VERSION}</b></div>
  </div>

  <div id="out"></div>
</div>

<script>
let chartLine=null, chartBars=null;

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function formatMileage(n){ const x=Number(n); return Number.isFinite(x)? x.toLocaleString('ru-RU')+' км' : '—'; }
function formatMoney(n){ const x=Number(n); return Number.isFinite(x)? x.toLocaleString('ru-RU')+' ₽' : '—'; }
function formatNum(n){ const x=Number(n); return Number.isFinite(x)? x.toLocaleString('ru-RU') : '—'; }

function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
  if(chartLine){chartLine.destroy(); chartLine=null;}
  if(chartBars){chartBars.destroy(); chartBars=null;}
}

// ✅ НИГДЕ НЕ ИСПОЛЬЗУЕМ response.json()
async function fetchMaybeJson(url){
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  return { ok: r.ok, status: r.status, text, json };
}

function renderSourceCard(marketing, key){
  const t = marketing?.bySource?.[key]?.total || null;
  if(!t) return \`<div class="sourceCard"><div class="name">\${esc(key)}</div><div class="muted">Нет данных</div></div>\`;
  const ch = t.chats || {};
  const sum = (t.sumWithBonusesExpenses ?? t.sumExpenses);
  return \`
    <div class="sourceCard">
      <div class="name">\${esc(key)}</div>
      <div class="muted">Просмотры: <b>\${formatNum(t.views)}</b></div>
      <div class="muted">Чаты: <b>\${formatNum(ch.total)}</b></div>
      <div class="muted">Расходы: <b>\${sum!=null?formatMoney(sum):'—'}</b></div>
    </div>\`;
}

function renderMarketing(marketing){
  if(!marketing || marketing.ok === false){
    const msg = marketing?.details || marketing?.message || 'Маркетинг не удалось получить';
    return '<div class="error">' + esc(msg) + '</div>';
  }

  const total = marketing.total || {};
  const chats = total.chats || {};
  const sum = (total.sumWithBonusesExpenses ?? total.sumExpenses);

  return \`
    <hr class="sep"/>
    <div class="sectionTitle">Маркетинговая статистика (\${esc(marketing.period?.startDate)} — \${esc(marketing.period?.endDate)})</div>
    <div class="muted">grouping: \${esc(marketing.grouping || 'periodDay')}</div>

    <div class="grid">
      <div class="kpi"><div class="label">Просмотры</div><div class="value">\${formatNum(total.views)}</div></div>
      <div class="kpi"><div class="label">Чаты (всего / пропущено / платные)</div><div class="value">\${formatNum(chats.total)} / \${formatNum(chats.missed)} / \${formatNum(chats.targeted)}</div></div>
      <div class="kpi"><div class="label">Расходы всего (с бонусами)</div><div class="value">\${sum!=null?formatMoney(sum):'—'}</div></div>
      <div class="kpi"><div class="label">Размещение / Звонки / Чаты / Тариф</div>
        <div class="value" style="font-size:16px">
          \${total.placementExpenses!=null?formatMoney(total.placementExpenses):'—'} /
          \${total.callsExpenses!=null?formatMoney(total.callsExpenses):'—'} /
          \${total.chatsExpenses!=null?formatMoney(total.chatsExpenses):'—'} /
          \${total.tariffsExpenses!=null?formatMoney(total.tariffsExpenses):'—'}
        </div>
      </div>
    </div>

    <div class="split">
      <div class="panel">
        <div style="font-weight:900;margin-bottom:10px">Динамика: просмотры и чаты</div>
        <canvas id="lineChart" height="120"></canvas>
      </div>
      <div class="panel">
        <div style="font-weight:900;margin-bottom:10px">Чаты по источникам</div>
        <canvas id="barChart" height="120"></canvas>
      </div>
    </div>

    <div class="sectionTitle" style="margin-top:16px">Трафик с классифайдов</div>
    <div class="sourceGrid">
      \${renderSourceCard(marketing,'auto.ru')}
      \${renderSourceCard(marketing,'avito.ru')}
      \${renderSourceCard(marketing,'drom.ru')}
    </div>\`;
}

function drawCharts(marketing){
  const stats = Array.isArray(marketing?.stats) ? marketing.stats : [];
  const labels = stats.map(x => String(x.date||'').slice(0,10)).filter(Boolean);
  const views = stats.map(x => Number(x?.views||0));
  const chats = stats.map(x => Number(x?.chats?.total||0));

  const ctx1 = document.getElementById("lineChart")?.getContext("2d");
  if(ctx1){
    if(chartLine) chartLine.destroy();
    chartLine = new Chart(ctx1, {
      type:"line",
      data:{ labels, datasets:[
        {label:"Просмотры", data:views, tension:0.25},
        {label:"Чаты", data:chats, tension:0.25}
      ]},
      options:{ responsive:true, plugins:{ legend:{ position:"bottom" } } }
    });
  }

  const srcKeys=["auto.ru","avito.ru","drom.ru"];
  const srcChats = srcKeys.map(k => Number(marketing?.bySource?.[k]?.total?.chats?.total||0));

  const ctx2 = document.getElementById("barChart")?.getContext("2d");
  if(ctx2){
    if(chartBars) chartBars.destroy();
    chartBars = new Chart(ctx2, {
      type:"bar",
      data:{ labels:srcKeys, datasets:[{label:"Чаты", data:srcChats}] },
      options:{ responsive:true, plugins:{ legend:{ position:"bottom" } } }
    });
  }
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML='<div class="card"><div class="error">Введите VIN</div></div>'; return; }
  if(vin.length!==17){ out.innerHTML='<div class="card"><div class="error">VIN должен быть 17 символов</div></div>'; return; }

  btn.disabled=true;
  out.innerHTML='<div class="card"><div class="muted">Запрос…</div></div>';

  try{
    const resp = await fetchMaybeJson('/check-vin?vin=' + encodeURIComponent(vin) + '&v=${APP_VERSION}');
    if(!resp.json){
      const snippet = resp.text.slice(0, 500);
      out.innerHTML = \`
        <div class="card">
          <div class="error">Сервер вернул НЕ JSON (status \${resp.status}). Это и есть причина “Unexpected token &lt;”.</div>
          <div class="details">\${esc(snippet)}</div>
          <div class="footer">version: <b>${APP_VERSION}</b></div>
        </div>\`;
      return;
    }

    const data = resp.json;
    if(!resp.ok || data?.ok===false){
      out.innerHTML = '<div class="card"><div class="error">' + esc(data?.message || data?.error || 'Ошибка запроса') + '</div></div>';
      return;
    }

    out.innerHTML = \`
      <div class="card">
        <div class="titleRow">
          <div>
            <div class="title">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</div>
            <div class="muted" style="margin-top:6px">VIN: <b>\${esc(vin)}</b></div>
          </div>
          <div class="muted">dealerId: <b>\${esc(data.dealerId ?? '—')}</b></div>
        </div>

        <div class="grid">
          <div class="kpi"><div class="label">Комплектация</div><div class="value" style="font-size:18px">\${esc(data.equipmentName||'—')}</div></div>
          <div class="kpi"><div class="label">Модификация</div><div class="value" style="font-size:18px">\${esc(data.modificationName||'—')}</div></div>
          <div class="kpi"><div class="label">Пробег</div><div class="value">\${esc(formatMileage(data.mileage))}</div></div>
          <div class="kpi"><div class="label">Цвет</div><div class="value" style="font-size:18px">\${esc(data.color||'—')}</div></div>
        </div>

        \${renderMarketing(data.marketing)}
        <div class="footer">version: <b>${APP_VERSION}</b></div>
      </div>\`;

    if(data?.marketing?.ok){
      setTimeout(() => drawCharts(data.marketing), 0);
    }
  }catch(e){
    out.innerHTML='<div class="card"><div class="error">Ошибка: ' + esc(e.message) + '</div></div>';
  }finally{
    btn.disabled=false;
  }
}
</script>
</body>
</html>`);
});

// -------------------- /check-vin (всегда JSON) --------------------
app.get("/check-vin", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  try {
    const token = await getToken();

    // 1) авто
    const carResponse = await http.get("https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car", {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    });

    const c = carResponse.data || {};

    // 2) маркетинг (как было у тебя)
    const endDate = toISODate(new Date());
    const startDate = toISODate(addDays(new Date(), -30));

    let marketing = { ok: false, message: "Маркетинг не удалось получить" };

    if (c.dealerId) {
      const sources = ["auto.ru", "avito.ru", "drom.ru"];
      const tasks = [
        fetchMarketing({ token, dealerId: c.dealerId, startDate, endDate, siteSource: null }),
        ...sources.map((s) => fetchMarketing({ token, dealerId: c.dealerId, startDate, endDate, siteSource: s })),
      ];

      const results = await Promise.allSettled(tasks);
      const base = results[0].status === "fulfilled" ? results[0].value : null;

      const bySource = {};
      sources.forEach((s, idx) => {
        const rr = results[idx + 1];
        if (rr.status === "fulfilled") {
          bySource[s] = { ok: true, total: rr.value?.data?.total || null, stats: rr.value?.data?.stats || null };
        } else {
          bySource[s] = { ok: false, total: null, stats: null };
        }
      });

      if (base && base.ok) {
        marketing = {
          ok: true,
          grouping: "periodDay",
          period: { startDate, endDate },
          total: base.data?.total || null,
          stats: base.data?.stats || null,
          bySource,
          dealerId: c.dealerId,
        };
      } else {
        const reason =
          results[0].status === "rejected"
            ? (results[0].reason?.response?.data?.message || results[0].reason?.message || "Ошибка запроса маркетинга")
            : "Ошибка запроса маркетинга";
        marketing = { ok: false, message: "Маркетинг не удалось получить", details: reason, period: { startDate, endDate }, dealerId: c.dealerId };
      }
    } else {
      marketing = { ok: false, message: "Нет dealerId в ответе — маркетинг не запросить" };
    }

    return res.send(
      JSON.stringify({
        ok: true,
        brand: c.brand,
        model: c.model,
        year: c.year,
        equipmentName: c.equipmentName,
        modificationName: c.modificationName,
        mileage: c.mileage,
        color: c.color,
        dealerId: c.dealerId ?? null,
        marketing,
        version: APP_VERSION,
      })
    );
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    return res.status(status).send(
      JSON.stringify({
        ok: false,
        error: "API request failed",
        status,
        message: data?.message || data?.error || error.message,
        version: APP_VERSION,
      })
    );
  }
});

// Railway-friendly
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT, "version:", APP_VERSION));
