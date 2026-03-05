const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- axios: ВСЕГДА текст --------------------
const http = axios.create({
  timeout: 25000,
  responseType: "text",
  transformResponse: [(d) => d], // не парсим автоматически
  validateStatus: () => true, // 4xx/5xx тоже возвращаем телом
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
function snippet(s, n = 900) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function tryParseJson(text) {
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function browserHeaders(extra = {}) {
  // “как браузер” — часто это важно для lk.* доменов
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Origin: "https://lk.cm.expert",
    Referer: "https://lk.cm.expert/",
    ...extra,
  };
}

async function postExpectJson(url, body, headers) {
  const r = await http.post(url, body, { headers: browserHeaders(headers) });
  const contentType = r.headers?.["content-type"] || "";
  const status = r.status;

  const parsed = tryParseJson(r.data);

  // если пришел HTML/текст — это твой кейс <!DOCTYPE ...>
  if (!parsed.ok) {
    const err = new Error(`Non-JSON response from ${url} (status ${status})`);
    err.kind = "NON_JSON";
    err.status = status;
    err.url = url;
    err.contentType = contentType;
    err.bodySnippet = snippet(r.data, 1200);
    throw err;
  }

  // JSON есть, но может быть ошибка API (4xx/5xx)
  if (status < 200 || status >= 300) {
    const err = new Error(
      parsed.json?.message ||
        parsed.json?.error ||
        `API error from ${url} (status ${status})`
    );
    err.kind = "API_ERROR";
    err.status = status;
    err.url = url;
    err.apiBody = parsed.json;
    throw err;
  }

  return parsed.json;
}

async function getExpectJson(url, params, headers) {
  const r = await http.get(url, { params, headers: browserHeaders(headers) });
  const contentType = r.headers?.["content-type"] || "";
  const status = r.status;

  const parsed = tryParseJson(r.data);
  if (!parsed.ok) {
    const err = new Error(`Non-JSON response from ${url} (status ${status})`);
    err.kind = "NON_JSON";
    err.status = status;
    err.url = url;
    err.contentType = contentType;
    err.bodySnippet = snippet(r.data, 1200);
    throw err;
  }

  if (status < 200 || status >= 300) {
    const err = new Error(
      parsed.json?.message ||
        parsed.json?.error ||
        `API error from ${url} (status ${status})`
    );
    err.kind = "API_ERROR";
    err.status = status;
    err.url = url;
    err.apiBody = parsed.json;
    throw err;
  }

  return parsed.json;
}

// -------------------- token cache --------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) return tokenCache.token;

  // oauth обычно нормально работает на lk.cm.expert
  const tokenJson = await postExpectJson(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  const token = tokenJson.access_token;
  const expiresIn = Number(tokenJson.expires_in || 3600);

  tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

// -------------------- API endpoints (по доке часто есть отдельный api домен) --------------------
const ENDPOINTS = {
  carFindLastByVin: [
    "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
    "https://api.cm.expert/api/v1/car/appraisal/find-last-by-car", // fallback
  ],
  marketingStockCars: [
    "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars",
    "https://api.cm.expert/api/v1/marketing-statistics/stock-cars", // fallback
  ],
};

async function fetchCarByVin({ token, vin }) {
  let lastErr = null;
  for (const url of ENDPOINTS.carFindLastByVin) {
    try {
      return await getExpectJson(url, { vin }, { Authorization: `Bearer ${token}` });
    } catch (e) {
      lastErr = e;
      // если не JSON/гейтвей — пробуем следующий url
      continue;
    }
  }
  throw lastErr || new Error("Car API failed");
}

async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const body = {
    grouping: "periodDay",
    dealerIds: [dealerId], // как у тебя в рабочей версии
    siteSource,
    startDate,
    endDate,
  };

  let lastErr = null;
  for (const url of ENDPOINTS.marketingStockCars) {
    try {
      const data = await postExpectJson(url, body, {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      });
      return { ok: true, data, request: { url, body } };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("Marketing API failed");
}

// -------------------- UI --------------------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Проверка авто по VIN</title>
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
.card{background:var(--card);border:1px solid rgba(229,231,235,.8);border-radius:18px;padding:18px;box-shadow:0 14px 40px rgba(15,23,42,.06);margin-top:16px;}
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
</style>
</head>
<body>
<div class="container">
  <div>
    <h1>Проверка автомобиля по VIN</h1>
    <div class="sub">Период маркетинга: последние 30 дней. Запросы к маркетингу делаем “как браузер” + fallback на api.cm.expert.</div>
  </div>

  <div class="card">
    <div class="row">
      <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
      <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
    </div>
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

// ✅ НИКОГДА не делаем response.json() — только text() + JSON.parse
async function fetchMaybeJson(url){
  const r = await fetch(url, { cache:"no-store" });
  const text = await r.text();
  let json=null;
  try{ json=JSON.parse(text); }catch(e){}
  return { ok:r.ok, status:r.status, text, json };
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
    const msg = marketing?.message || 'Маркетинг недоступен';
    const det = marketing?.details ? '<div class="details">'+esc(marketing.details)+'</div>' : '';
    return '<hr class="sep"/><div class="error">'+esc(msg)+det+'</div>';
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
    const resp = await fetchMaybeJson('/check-vin?vin=' + encodeURIComponent(vin));
    if(!resp.json){
      out.innerHTML = '<div class="card"><div class="error">Сервер вернул НЕ JSON (status '+resp.status+')</div><div class="details">'+esc(resp.text.slice(0,700))+'</div></div>';
      return;
    }
    const data = resp.json;

    if(!resp.ok || data?.ok===false){
      out.innerHTML = '<div class="card"><div class="error">'+esc(data?.message || data?.error || 'Ошибка запроса')+'</div></div>';
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
      </div>\`;

    if(data?.marketing?.ok){
      setTimeout(() => drawCharts(data.marketing), 0);
    }
  }catch(e){
    out.innerHTML='<div class="card"><div class="error">Ошибка: '+esc(e.message)+'</div></div>';
  }finally{
    btn.disabled=false;
  }
}
</script>
</body>
</html>`);
});

// -------------------- /check-vin --------------------
app.get("/check-vin", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  try {
    const token = await getToken();

    // 1) авто по VIN (с fallback на api.cm.expert)
    const c = await fetchCarByVin({ token, vin });

    // 2) маркетинг последние 30 дней
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
        const err = results[0].status === "rejected" ? results[0].reason : null;
        const details =
          err?.kind === "NON_JSON"
            ? `CM.Expert ответил HTML вместо JSON.\nstatus: ${err.status}\ncontent-type: ${err.contentType}\nurl: ${err.url}\n\n${err.bodySnippet}`
            : (err?.message || "Ошибка запроса маркетинга");

        marketing = {
          ok: false,
          message: "Маркетинг недоступен",
          details,
          period: { startDate, endDate },
          dealerId: c.dealerId,
        };
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
      })
    );
  } catch (error) {
    if (error?.kind === "NON_JSON") {
      return res.status(502).send(
        JSON.stringify({
          ok: false,
          error: "CM.Expert returned non-JSON",
          status: error.status,
          message: "CM.Expert вернул HTML вместо JSON",
          details: `content-type: ${error.contentType}\nurl: ${error.url}\n\n${error.bodySnippet}`,
        })
      );
    }

    const status = error?.status || error?.response?.status || 500;
    return res.status(status).send(
      JSON.stringify({
        ok: false,
        error: "API request failed",
        status,
        message: error?.message || "Unknown error",
      })
    );
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
