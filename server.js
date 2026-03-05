const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- axios --------------------
const http = axios.create({ timeout: 25000 });

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
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
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

// -------------------- marketing API (тот же эндпоинт, но “за всё время” через авто-fallback по периоду) --------------------
async function fetchMarketingOnce({ token, dealerId, startDate, endDate, siteSource = null }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  // ВАЖНО: dealerIds по доке integer[]
  const dealerIdNum = Number(dealerId);

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
      Accept: "application/json",
    },
  });

  return r.data;
}

// Пытаемся получить "максимально широкий" период. Если API ограничивает окно, сужаем.
async function fetchMarketingAllTime({ token, dealerId, siteSource = null }) {
  const end = new Date();

  // порядок важен: сначала максимально широко
  const windowsDays = [3650, 1825, 1095, 730, 365, 180, 90, 30];

  let lastError = null;

  for (const days of windowsDays) {
    const start = addDays(end, -days);
    const startDate = toISODate(start);
    const endDate = toISODate(end);

    try {
      const data = await fetchMarketingOnce({
        token,
        dealerId,
        startDate,
        endDate,
        siteSource,
      });

      // Если API вернул структуру, но total пустой/нулевой — это всё равно “валидный” ответ,
      // но мы попробуем взять более широкий диапазон уже пробовали. На этом шаге — возвращаем.
      return {
        ok: true,
        period: { startDate, endDate, mode: `auto-${days}d` },
        data,
      };
    } catch (e) {
      lastError = e;
      // идём дальше, сужаем окно
      continue;
    }
  }

  return {
    ok: false,
    message: "Маркетинг не удалось получить ни для одного периода",
    details: lastError?.response?.data?.message || lastError?.message || "Unknown error",
  };
}

// -------------------- routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Проверка авто по VIN</title>
  <style>
    :root{
      --bg:#f5f6fb; --card:#fff; --muted:#6b7280; --text:#0f172a;
      --accent:#ff5a2c; --border:#e5e7eb;
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
      <div class="sub">Маркетинг показываем “за всё время” (авто-режим: пробуем широкий период и сужаем, если API ограничивает).</div>
    </div>

    <div class="card">
      <div class="row">
        <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>
        <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
        <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
      </div>
      <div class="muted" style="margin-top:10px">Графики отключены. Показываем только totals + классифайды.</div>
    </div>

    <div id="out"></div>
  </div>

<script>
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}
function formatMileage(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU') + ' км';
}
function formatMoney(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU') + ' ₽';
}
function formatNum(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU');
}

function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}

// безопасно читаем JSON
async function fetchAny(url){
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  return { ok: r.ok, status: r.status, text, json };
}

function renderSourceCard(marketing, key){
  const t = marketing?.bySource?.[key]?.total || null;
  if(!t){
    return \`
      <div class="sourceCard">
        <div class="name">\${esc(key)}</div>
        <div class="muted">Нет данных</div>
      </div>\`;
  }
  const ch = t.chats || {};
  const sum = (t.sumWithBonusesExpenses ?? t.sumExpenses);
  return \`
    <div class="sourceCard">
      <div class="name">\${esc(key)}</div>
      <div class="muted">Просмотры: <b>\${formatNum(t.views)}</b></div>
      <div class="muted">Чаты: <b>\${formatNum(ch.total)}</b></div>
      <div class="muted">Расходы: <b>\${sum!=null ? formatMoney(sum) : '—'}</b></div>
    </div>\`;
}

function renderMarketing(marketing){
  if(!marketing || marketing.ok === false){
    const msg = marketing?.message || 'Маркетинг недоступен';
    const det = marketing?.details ? '<div class="details">' + esc(marketing.details) + '</div>' : '';
    return '<hr class="sep"/><div class="error">' + esc(msg) + det + '</div>';
  }

  const total = marketing.total || {};
  const chats = total.chats || {};
  const sum = (total.sumWithBonusesExpenses ?? total.sumExpenses);

  return \`
    <hr class="sep"/>
    <div class="sectionTitle">Маркетинг (totals за весь доступный период)</div>
    <div class="muted">Период: <b>\${esc(marketing.period?.startDate)} — \${esc(marketing.period?.endDate)}</b> · режим: <b>\${esc(marketing.period?.mode || 'auto')}</b></div>

    <div class="grid" style="margin-top:12px;">
      <div class="kpi">
        <div class="label">Просмотры</div>
        <div class="value">\${formatNum(total.views)}</div>
      </div>
      <div class="kpi">
        <div class="label">Чаты (всего / пропущено / платные)</div>
        <div class="value">\${formatNum(chats.total)} / \${formatNum(chats.missed)} / \${formatNum(chats.targeted)}</div>
      </div>
      <div class="kpi">
        <div class="label">Расходы всего (с бонусами)</div>
        <div class="value">\${sum != null ? formatMoney(sum) : '—'}</div>
      </div>
      <div class="kpi">
        <div class="label">Размещение / Звонки / Чаты / Тариф</div>
        <div class="value" style="font-size:16px">
          \${total.placementExpenses != null ? formatMoney(total.placementExpenses) : '—'} /
          \${total.callsExpenses != null ? formatMoney(total.callsExpenses) : '—'} /
          \${total.chatsExpenses != null ? formatMoney(total.chatsExpenses) : '—'} /
          \${total.tariffsExpenses != null ? formatMoney(total.tariffsExpenses) : '—'}
        </div>
      </div>
    </div>

    <div class="sectionTitle" style="margin-top:16px;">Классифайды</div>
    <div class="sourceGrid">
      \${renderSourceCard(marketing,'auto.ru')}
      \${renderSourceCard(marketing,'avito.ru')}
      \${renderSourceCard(marketing,'drom.ru')}
    </div>
  \`;
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML = '<div class="card"><div class="error">Введите VIN</div></div>'; return; }
  if(vin.length !== 17){ out.innerHTML = '<div class="card"><div class="error">VIN должен быть 17 символов</div></div>'; return; }

  btn.disabled = true;
  out.innerHTML = '<div class="card"><div class="muted">Запрос...</div></div>';

  try{
    const resp = await fetchAny('/check-vin?vin=' + encodeURIComponent(vin));
    if(!resp.json){
      out.innerHTML = '<div class="card"><div class="error">Сервер вернул НЕ JSON (status '+resp.status+')</div><div class="details">'+esc(resp.text.slice(0,800))+'</div></div>';
      return;
    }

    const data = resp.json;

    if(!resp.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="card"><div class="error">' + esc(msg) + '</div></div>';
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
            <div class="value">\${esc(formatMileage(data.mileage))}</div>
          </div>
          <div class="kpi">
            <div class="label">Цвет</div>
            <div class="value" style="font-size:18px">\${esc(data.color || '—')}</div>
          </div>
        </div>

        \${renderMarketing(data.marketing)}
      </div>
    \`;
  }catch(e){
    out.innerHTML = '<div class="card"><div class="error">Ошибка: ' + esc(e.message) + '</div></div>';
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// -------------------- main endpoint --------------------
app.get("/check-vin", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  try {
    const token = await getToken();

    // 1) авто по VIN
    const carResponse = await http.get(
      "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      {
        params: { vin },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const c = carResponse.data || {};

    // 2) маркетинг “за всё время” (авто-fallback)
    let marketing = { ok: false, message: "Маркетинг не удалось получить" };

    if (c.dealerId != null) {
      const base = await fetchMarketingAllTime({ token, dealerId: c.dealerId, siteSource: null });

      if (base.ok) {
        const sources = ["auto.ru", "avito.ru", "drom.ru"];
        const tasks = sources.map((s) => fetchMarketingAllTime({ token, dealerId: c.dealerId, siteSource: s }));

        const results = await Promise.allSettled(tasks);

        const bySource = {};
        sources.forEach((s, idx) => {
          const rr = results[idx];
          if (rr.status === "fulfilled" && rr.value?.ok) {
            bySource[s] = {
              ok: true,
              total: rr.value?.data?.total || null,
              // stats нам больше не нужны — “лагов” нет, графики убрали
            };
          } else {
            bySource[s] = { ok: false, total: null };
          }
        });

        marketing = {
          ok: true,
          grouping: "periodDay",
          period: base.period,
          total: base.data?.total || null,
          bySource,
          dealerId: Number(c.dealerId),
        };
      } else {
        marketing = base;
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
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    return res.status(status).send(
      JSON.stringify({
        ok: false,
        error: "API request failed",
        status,
        message: data?.message || data?.error || error.message,
      })
    );
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
