// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- базовые настройки --------------------
const http = axios.create({
  timeout: 20000,
});

// CORS
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

// -------------------- token cache (чтобы ускорить) --------------------
let tokenCache = {
  token: null,
  expiresAt: 0,
};

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) {
    return tokenCache.token;
  }

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
  const expiresIn = Number(tokenResponse.data.expires_in || 3600); // сек
  tokenCache = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return token;
}

// -------------------- marketing API --------------------
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  // В swagger enum по grouping: 'periodDay' (и иногда показывают 'stockCard', но у вас он не принимается)
  // Поэтому используем только periodDay — он у вас реально сработал.
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping: "periodDay",
    dealerIds: [dealerId],
    siteSource, // null / 'auto.ru' / 'avito.ru' / 'drom.ru'
    startDate,
    endDate,
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const r = await http.post(url, body, { headers });
  return { ok: true, data: r.data, request: { url, body } };
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
    body{font-family:Arial, sans-serif; max-width:980px; margin:40px auto; padding:0 16px; background:#f4f4f4;}
    h1{font-size:44px; margin:0 0 18px;}
    .card{background:#fff; border-radius:18px; padding:26px; box-shadow:0 12px 40px rgba(0,0,0,.10);}
    .input{width:100%; padding:16px; font-size:18px; border:1px solid #ddd; border-radius:10px; outline:none;}
    .row{display:flex; gap:12px; margin-top:14px; flex-wrap:wrap;}
    .btn{padding:14px 20px; font-size:16px; border:none; border-radius:10px; cursor:pointer;}
    .btn-primary{background:#ff5a2c; color:#fff;}
    .btn-secondary{background:#eee; color:#111;}
    .btn:disabled{opacity:.6; cursor:not-allowed;}
    .muted{color:#777; font-size:14px; margin-top:10px;}
    .result{margin-top:18px;}
    .title{font-size:34px; font-weight:900; margin:8px 0 14px;}
    .grid{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
    .item{border:1px solid #eee; border-radius:14px; padding:14px 16px;}
    .label{color:#777; font-size:13px; margin-bottom:8px;}
    .value{font-size:20px; font-weight:900; color:#111;}
    .error{background:#fff2f2; border:1px solid #ffd1d1; color:#b00020; padding:12px 14px; border-radius:12px;}
    .loading{color:#555;}
    .section{margin-top:18px;}
    .section h3{margin:0 0 10px; font-size:22px;}
    .sub{margin:6px 0 0; color:#666; font-size:14px;}
    @media(max-width:720px){ .grid{grid-template-columns:1fr;} h1{font-size:34px;} .title{font-size:28px;} }
  </style>
</head>
<body>
  <div class="card">
    <h1>Проверка автомобиля по VIN</h1>

    <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>

    <div class="row">
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить VIN</button>
      <button class="btn btn-secondary" onclick="resetAll()">Очистить</button>
    </div>

    <div class="muted">Данные берутся из API. Если VIN неверный — покажем ошибку.</div>

    <div class="result" id="out"></div>
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
function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}

function renderMarketing(marketing){
  if(!marketing || marketing.ok === false){
    const msg = marketing?.message || 'Маркетинг не удалось получить';
    return '<div class="muted">' + esc(msg) + '</div>';
  }

  const total = marketing.total || {};
  const chats = total.chats || {};
  const bySource = marketing.bySource || {};

  const srcCard = (key, title) => {
    const t = (bySource[key] && bySource[key].total) ? bySource[key].total : null;
    if(!t) {
      return \`
        <div class="item">
          <div class="label">\${esc(title)}</div>
          <div class="value">—</div>
        </div>
      \`;
    }
    const ch = t.chats || {};
    const sum = (t.sumWithBonusesExpenses ?? t.sumExpenses);
    return \`
      <div class="item">
        <div class="label">\${esc(title)}</div>
        <div class="value">
          Просмотры: \${t.views ?? '—'} · Чаты: \${ch.total ?? '—'} · Расходы: \${sum != null ? formatMoney(sum) : '—'}
        </div>
      </div>
    \`;
  };

  return \`
    <div class="section">
      <h3>Маркетинговая статистика (за \${esc(marketing.period?.startDate)} — \${esc(marketing.period?.endDate)})</h3>
      <div class="sub">grouping: \${esc(marketing.grouping || 'periodDay')}</div>

      <div class="grid" style="margin-top:12px;">
        <div class="item">
          <div class="label">Просмотры</div>
          <div class="value">\${total.views ?? '—'}</div>
        </div>

        <div class="item">
          <div class="label">Чаты (всего / пропущено / платные)</div>
          <div class="value">\${chats.total ?? '—'} / \${chats.missed ?? '—'} / \${chats.targeted ?? '—'}</div>
        </div>

        <div class="item">
          <div class="label">Расходы всего (с бонусами)</div>
          <div class="value">\${total.sumWithBonusesExpenses != null ? formatMoney(total.sumWithBonusesExpenses) : (total.sumExpenses != null ? formatMoney(total.sumExpenses) : '—')}</div>
        </div>

        <div class="item">
          <div class="label">Расходы: размещение / звонки / чаты / тариф</div>
          <div class="value">
            \${total.placementExpenses != null ? formatMoney(total.placementExpenses) : '—'} /
            \${total.callsExpenses != null ? formatMoney(total.callsExpenses) : '—'} /
            \${total.chatsExpenses != null ? formatMoney(total.chatsExpenses) : '—'} /
            \${total.tariffsExpenses != null ? formatMoney(total.tariffsExpenses) : '—'}
          </div>
        </div>
      </div>

      <div class="section" style="margin-top:18px;">
        <h3>Трафик с классифайдов</h3>
        <div class="grid">
          \${srcCard('auto.ru', 'auto.ru')}
          \${srcCard('avito.ru', 'avito.ru')}
          \${srcCard('drom.ru', 'drom.ru')}
        </div>
        <div class="muted">Если по источникам пусто — значит API не вернул разбивку или данных нет за период.</div>
      </div>
    </div>
  \`;
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML = '<div class="error">Введите VIN</div>'; return; }
  if(vin.length !== 17){ out.innerHTML = '<div class="error">VIN должен быть 17 символов</div>'; return; }

  btn.disabled = true;
  out.innerHTML = '<div class="loading">Запрос...</div>';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();

    if(!r.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="error">' + esc(msg) + '</div>';
      return;
    }

    out.innerHTML = \`
      <div class="title">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</div>

      <div class="grid">
        <div class="item">
          <div class="label">Комплектация</div>
          <div class="value">\${esc(data.equipmentName || '—')}</div>
        </div>

        <div class="item">
          <div class="label">Модификация</div>
          <div class="value">\${esc(data.modificationName || '—')}</div>
        </div>

        <div class="item">
          <div class="label">Пробег</div>
          <div class="value">\${esc(formatMileage(data.mileage))}</div>
        </div>

        <div class="item">
          <div class="label">Цвет</div>
          <div class="value">\${esc(data.color || '—')}</div>
        </div>
      </div>

      \${renderMarketing(data.marketing)}
    \`;
  }catch(e){
    out.innerHTML = '<div class="error">Ошибка: ' + esc(e.message) + '</div>';
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// VIN -> нужные поля + маркетинг
app.get("/check-vin", async (req, res) => {
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok: false, error: "VIN is required" });

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

    // 2) маркетинг (последние 30 дней; в swagger есть ограничение ~31 день)
    const endDate = toISODate(new Date());
    const startDate = toISODate(addDays(new Date(), -30));

    let marketing = { ok: false, message: "Маркетинг не удалось получить" };

    if (c.dealerId) {
      // делаем 4 запроса параллельно, чтобы было быстрее
      const sources = ["auto.ru", "avito.ru", "drom.ru"];
      const tasks = [
        fetchMarketing({ token, dealerId: c.dealerId, startDate, endDate, siteSource: null }),
        ...sources.map((s) =>
          fetchMarketing({ token, dealerId: c.dealerId, startDate, endDate, siteSource: s })
        ),
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
        };
      } else {
        // покажем более понятную причину (например 400/403)
        const reason =
          results[0].status === "rejected"
            ? (results[0].reason?.response?.data?.message || results[0].reason?.message || "Ошибка запроса маркетинга")
            : "Ошибка запроса маркетинга";

        marketing = {
          ok: false,
          message: "Маркетинг не удалось получить",
          details: reason,
          period: { startDate, endDate },
        };
      }
    } else {
      marketing = { ok: false, message: "Нет dealerId в ответе — маркетинг не запросить" };
    }

    return res.json({
      ok: true,
      brand: c.brand,
      model: c.model,
      year: c.year,
      equipmentName: c.equipmentName,
      modificationName: c.modificationName,
      mileage: c.mileage,
      color: c.color,
      marketing,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    return res.status(status).json({
      ok: false,
      error: "API request failed",
      status,
      message: data?.message || data?.error || error.message,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
