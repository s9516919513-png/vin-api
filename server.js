// server.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3000;

// чтобы Railway/браузер могли дергать API
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// helpers
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("ru-RU");
}
function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("ru-RU") + " ₽";
}
function safeStr(v) {
  if (v === null || v === undefined) return "—";
  const s = String(v).trim();
  return s ? s : "—";
}

// Получаем токен
async function getToken() {
  const tokenResponse = await axios.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return tokenResponse.data.access_token;
}

// Получаем последнюю оценку по VIN
async function fetchCarByVin({ token, vin }) {
  const carResponse = await axios.get(
    "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
    {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return carResponse.data;
}

// Маркетинговая статистика (валидное тело по swagger: grouping, dealerIds, siteSource, startDate, endDate)
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping: "stockCardId",
    dealerIds: [dealerId],
    startDate,
    endDate,
    siteSource, // null = все источники
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return r.data;
}

// Берём статистику конкретно по одной машине из ответа marketing-statistics
function pickMarketingForCar(marketingPayload, carId) {
  if (!marketingPayload) return null;

  const statsArr = Array.isArray(marketingPayload.stats) ? marketingPayload.stats : [];
  // при grouping=stockCardId ожидаем groupBy == carId (иногда строкой)
  const found = statsArr.find((x) => String(x.groupBy) === String(carId));

  // total — агрегат по всем машинам/фильтрам, нам он не нужен, но можно использовать как fallback
  return found || null;
}

function normalizeMarketing(stat) {
  if (!stat) return null;

  // по swagger TotalStatistics: views, chats{...}, promotionExpenses, placementExpenses, callsExpenses, chatsExpenses, tariffsExpenses, sumExpenses, sumWithBonusesExpenses
  const total = stat.total || stat; // иногда API кладёт прямо в объект группы
  const chats = total.chats || {};

  return {
    views: total.views ?? null,

    chatsTotal: chats.total ?? null,
    chatsMissed: chats.missed ?? null,
    chatsTargeted: chats.targeted ?? null,

    promotionExpenses: total.promotionExpenses ?? null,
    promotionBonusesExpenses: total.promotionBonusesExpenses ?? null,
    placementExpenses: total.placementExpenses ?? null,
    callsExpenses: total.callsExpenses ?? null,
    chatsExpenses: total.chatsExpenses ?? null,
    tariffsExpenses: total.tariffsExpenses ?? null,
    sumExpenses: total.sumExpenses ?? null,
    sumWithBonusesExpenses: total.sumWithBonusesExpenses ?? null,
  };
}

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// главная страница сайта
app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Проверка авто по VIN</title>
  <style>
    :root{--bg:#ffffff;--text:#0b1020;--muted:#6b7280;--card:#fff;--line:#e7e7e7;--accent:#ff5a2c;}
    body{font-family:Arial, sans-serif; max-width:980px; margin:40px auto; padding:0 16px; color:var(--text); background:var(--bg);}
    h1{font-size:56px; margin:0 0 18px;}
    .card{border:1px solid var(--line); border-radius:18px; padding:22px; box-shadow:0 10px 30px rgba(0,0,0,.05); background:var(--card);}
    .row{display:flex; gap:14px; flex-wrap:wrap; align-items:center;}
    input{width:100%; padding:16px; font-size:18px; border:1px solid #d7d7d7; border-radius:14px; outline:none;}
    input:focus{border-color:#bdbdbd;}
    .btn{padding:14px 22px; font-size:18px; border:none; border-radius:14px; cursor:pointer;}
    .btn.primary{background:var(--accent); color:#fff;}
    .btn.secondary{background:#efefef; color:#111;}
    .btn:disabled{opacity:.6; cursor:not-allowed;}
    .muted{color:var(--muted); font-size:18px; margin-top:10px;}
    .title{font-size:44px; font-weight:800; margin:26px 0 12px;}
    .grid{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:10px;}
    .item{border:1px solid var(--line); border-radius:16px; padding:16px;}
    .label{color:var(--muted); font-size:18px; margin-bottom:6px;}
    .value{font-size:26px; font-weight:700;}
    .section{margin-top:22px;}
    .section h3{margin:0 0 10px; font-size:28px;}
    .mgrid{display:grid; grid-template-columns:1fr 1fr; gap:16px;}
    .kv{display:flex; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid var(--line);}
    .kv:last-child{border-bottom:none;}
    .k{color:var(--muted); font-size:18px;}
    .v{font-size:20px; font-weight:700; text-align:right;}
    .error{background:#fff1f1; border:1px solid #ffd3d3; color:#b00020; padding:12px 14px; border-radius:14px; margin-top:14px; font-size:18px;}
    @media (max-width: 860px){
      h1{font-size:40px;}
      .title{font-size:34px;}
      .grid,.mgrid{grid-template-columns:1fr;}
      .value{font-size:22px;}
    }
  </style>
</head>
<body>
  <h1>Проверка автомобиля по VIN</h1>

  <div class="card">
    <input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17"/>
    <div class="row" style="margin-top:14px;">
      <button id="btn" class="btn primary" onclick="checkVin()">Проверить VIN</button>
      <button class="btn secondary" onclick="clearAll()">Очистить</button>
    </div>
    <div class="muted">Данные берутся из API. Если VIN неверный — покажем ошибку.</div>

    <div id="out" class="section"></div>
  </div>

<script>
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function clearAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}
function fmtInt(n){
  if(n===null || n===undefined || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('ru-RU');
}
function fmtMoney(n){
  if(n===null || n===undefined || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('ru-RU') + ' ₽';
}
async function checkVin(){
  const vinEl = document.getElementById('vin');
  const vin = vinEl.value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML = '<div class="error">Введите VIN</div>'; return; }
  if(vin.length !== 17){ out.innerHTML = '<div class="error">VIN должен быть 17 символов</div>'; return; }

  btn.disabled = true;
  out.innerHTML = '<div class="muted">Запрос...</div>';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();

    if(!r.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="error">' + esc(msg) + '</div>';
      return;
    }

    // Машина
    const car = data.car || {};
    const title = \`\${esc(car.brand)} \${esc(car.model)} \${esc(car.year)}\`;

    // Маркетинг
    const m = data.marketing;
    const marketingHtml = m ? \`
      <div class="mgrid">
        <div class="item">
          <div class="label">Просмотры</div>
          <div class="value">\${fmtInt(m.views)}</div>
        </div>
        <div class="item">
          <div class="label">Чаты</div>
          <div class="value">\${fmtInt(m.chatsTotal)}</div>
        </div>

        <div class="item">
          <div class="label">Пропущенные чаты</div>
          <div class="value">\${fmtInt(m.chatsMissed)}</div>
        </div>
        <div class="item">
          <div class="label">Платные чаты</div>
          <div class="value">\${fmtInt(m.chatsTargeted)}</div>
        </div>
      </div>

      <div class="section">
        <h3>Расходы</h3>
        <div class="item">
          <div class="kv"><div class="k">Размещение на классифайдах</div><div class="v">\${fmtMoney(m.placementExpenses)}</div></div>
          <div class="kv"><div class="k">Промо-услуги</div><div class="v">\${fmtMoney(m.promotionExpenses)}</div></div>
          <div class="kv"><div class="k">Звонки</div><div class="v">\${fmtMoney(m.callsExpenses)}</div></div>
          <div class="kv"><div class="k">Чаты</div><div class="v">\${fmtMoney(m.chatsExpenses)}</div></div>
          <div class="kv"><div class="k">Тариф</div><div class="v">\${fmtMoney(m.tariffsExpenses)}</div></div>
          <div class="kv"><div class="k"><b>Итого</b></div><div class="v"><b>\${fmtMoney(m.sumExpenses)}</b></div></div>
          <div class="kv"><div class="k">Итого с бонусами</div><div class="v">\${fmtMoney(m.sumWithBonusesExpenses)}</div></div>
        </div>
      </div>
    \` : \`<div class="muted" style="margin-top:14px;">Маркетинг не удалось получить (проверь доступ/права в API)</div>\`;

    out.innerHTML = \`
      <div class="title">\${title}</div>
      <div class="grid">
        <div class="item">
          <div class="label">Комплектация</div>
          <div class="value">\${esc(car.equipmentName)}</div>
        </div>
        <div class="item">
          <div class="label">Модификация</div>
          <div class="value">\${esc(car.modificationName)}</div>
        </div>
        <div class="item">
          <div class="label">Пробег</div>
          <div class="value">\${fmtInt(car.mileage)} км</div>
        </div>
        <div class="item">
          <div class="label">Цвет</div>
          <div class="value">\${esc(car.color)}</div>
        </div>
      </div>

      <div class="section">
        <h3>Маркетинговая статистика</h3>
        \${marketingHtml}
      </div>
    \`;

  }catch(e){
    out.innerHTML = '<div class="error">Ошибка: ' + esc(e.message) + '</div>';
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>
`);
});

// API endpoint
app.get("/check-vin", async (req, res) => {
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok: false, error: "VIN is required" });

  try {
    const token = await getToken();
    const car = await fetchCarByVin({ token, vin });

    // нормализуем нужные поля
    const carOut = {
      id: car.id,
      dealerId: car.dealerId,
      vin: car.vin,

      brand: car.brand,
      model: car.model,
      year: car.year,

      equipmentName: car.equipmentName,
      modificationName: car.modificationName,

      mileage: car.mileage,
      color: car.color,
    };

    // период по умолчанию: последние 30 дней (или можно поменять)
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toISO = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

    let marketing = null;

    try {
      const marketingPayload = await fetchMarketing({
        token,
        dealerId: car.dealerId,
        startDate: toISO(start),
        endDate: toISO(end),
        siteSource: null, // все источники
      });

      const statForCar = pickMarketingForCar(marketingPayload, car.id);
      marketing = normalizeMarketing(statForCar);
    } catch (e) {
      // маркетинг опциональный — не ломаем весь ответ
      marketing = null;
    }

    res.json({
      ok: true,
      car: carOut,
      marketing,
    });
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const message =
      (data && (data.message || data.error)) ||
      error.message ||
      "API request failed";

    res.status(status || 500).json({
      ok: false,
      error: message,
      status: status || 500,
      details: data || null,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
