const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3000;

// CORS (чтобы можно было дергать из браузера)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Главная страница
app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
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
    .title{font-size:26px; font-weight:800; margin:8px 0 14px;}
    .grid{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
    .item{border:1px solid #eee; border-radius:12px; padding:12px 14px;}
    .label{color:#777; font-size:13px; margin-bottom:6px;}
    .value{font-size:16px; font-weight:700; color:#111;}
    .error{background:#fff2f2; border:1px solid #ffd1d1; color:#b00020; padding:12px 14px; border-radius:12px;}
    .loading{color:#555;}
    .hidden{display:none;}
    pre{white-space:pre-wrap; word-break:break-word; background:#0b1020; color:#d7e1ff; padding:14px; border-radius:12px; overflow:auto;}
    @media(max-width:720px){ .grid{grid-template-columns:1fr;} h1{font-size:34px;} }
  </style>
</head>
<body>
  <div class="card">
    <h1>Проверка автомобиля по VIN</h1>

    <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>

    <div class="row">
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить VIN</button>
      <button class="btn btn-secondary" onclick="resetAll()">Очистить</button>
      <button id="btnJson" class="btn btn-secondary hidden" onclick="toggleJson()">Показать JSON</button>
    </div>

    <div class="muted">Данные берутся из API. Если VIN неверный — покажем ошибку.</div>

    <div class="result" id="out"></div>

    <div id="rawWrap" class="hidden" style="margin-top:14px;">
      <pre id="raw"></pre>
    </div>
  </div>

<script>
let lastRaw = null;
let jsonVisible = false;

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}

function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
  document.getElementById('rawWrap').classList.add('hidden');
  document.getElementById('btnJson').classList.add('hidden');
  jsonVisible = false;
  lastRaw = null;
}

function toggleJson(){
  jsonVisible = !jsonVisible;
  document.getElementById('rawWrap').classList.toggle('hidden', !jsonVisible);
  document.getElementById('btnJson').textContent = jsonVisible ? 'Скрыть JSON' : 'Показать JSON';
}

function formatMileage(n){
  if(n === null || n === undefined || n === '') return '';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU');
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');
  const btnJson = document.getElementById('btnJson');
  const raw = document.getElementById('raw');
  const rawWrap = document.getElementById('rawWrap');

  if(!vin){
    out.innerHTML = '<div class="error">Введите VIN</div>';
    return;
  }
  if(vin.length !== 17){
    out.innerHTML = '<div class="error">VIN должен быть 17 символов</div>';
    return;
  }

  btn.disabled = true;
  out.innerHTML = '<div class="loading">Запрос...</div>';
  btnJson.classList.add('hidden');
  rawWrap.classList.add('hidden');
  jsonVisible = false;

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();
    lastRaw = data;

    // На всякий случай сохраним raw
    raw.textContent = JSON.stringify(data, null, 2);

    if(!r.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="error">' + esc(msg) + '</div>';
      return;
    }

    // Рисуем красиво (без drive/gear/engine/volume/power)
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
          <div class="value">\${esc(formatMileage(data.mileage))} км</div>
        </div>

        <div class="item">
          <div class="label">Цвет</div>
          <div class="value">\${esc(data.color || '—')}</div>
        </div>
      </div>

      <div class="muted" style="margin-top:12px;">
        Маркетинговую статистику добавим следующим шагом (просмотры / чаты / расходы / трафик классифайдов).
      </div>
    \`;

    // Кнопка JSON (если нужно)
    btnJson.classList.remove('hidden');
    btnJson.textContent = 'Показать JSON';

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

// API: VIN -> только нужные поля
app.get("/check-vin", async (req, res) => {
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok:false, error: "VIN is required" });

  try {
    const tokenResponse = await axios.post(
      "https://lk.cm.expert/oauth/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const token = tokenResponse.data.access_token;

    const carResponse = await axios.get(
      "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      {
        params: { vin },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const c = carResponse.data || {};

    // Возвращаем ТОЛЬКО то, что нужно на странице
    return res.json({
      ok: true,
      brand: c.brand,
      model: c.model,
      year: c.year,
      equipmentName: c.equipmentName,
      modificationName: c.modificationName,
      mileage: c.mileage,
      color: c.color,
      // marketing: добавим следующим шагом
    });

  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    return res.status(status || 500).json({
      ok: false,
      error: "API request failed",
      status: status || 500,
      message: data?.message || data?.error || error.message,
      details: data || null,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
