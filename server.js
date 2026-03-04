const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// CORS (чтобы браузер мог дергать API)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// axios instance с таймаутом (важно, чтобы не ловить 502 от Railway)
const http = axios.create({
  timeout: 10000, // 10 секунд — если дольше, вернем ошибку сами, а не "Application failed to respond"
});

// ====== КЕШ ТОКЕНА (чтобы не дергать oauth/token каждый раз) ======
let cachedToken = null;
let cachedTokenExpMs = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpMs - 30_000) {
    // -30 сек запас
    return cachedToken;
  }

  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("CLIENT_ID/CLIENT_SECRET not set in Railway variables");
  }

  const tokenResponse = await http.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = tokenResponse.data?.access_token;
  const expiresIn = Number(tokenResponse.data?.expires_in || 3600);

  if (!token) throw new Error("No access_token in oauth response");

  cachedToken = token;
  cachedTokenExpMs = Date.now() + expiresIn * 1000;

  return token;
}

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Главная страница
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Проверка авто по VIN</title>
  <style>
    body{font-family:Arial, sans-serif; max-width:920px; margin:40px auto; padding:0 16px;}
    .card{border:1px solid #eee; border-radius:18px; padding:26px; box-shadow:0 6px 22px rgba(0,0,0,.06);}
    input{width:100%; padding:16px; font-size:18px; border:1px solid #ddd; border-radius:12px;}
    button{margin-top:14px; padding:14px 20px; font-size:16px; border:none; border-radius:12px; background:#ff5a2c; color:#fff; cursor:pointer;}
    button:disabled{opacity:.6; cursor:not-allowed;}
    .row{display:flex; gap:12px; margin-top:12px; flex-wrap:wrap;}
    .muted{color:#666; font-size:14px; margin-top:10px;}
    .result{margin-top:18px;}
    .title{font-size:28px; font-weight:800; margin:0 0 10px 0;}
    .grid{display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:12px;}
    .item{background:#f7f7f7; border-radius:12px; padding:12px 14px;}
    .label{color:#666; font-size:12px; margin-bottom:6px;}
    .value{font-size:16px; font-weight:700;}
    .error{background:#fff3f3; border:1px solid #ffd1d1; color:#b10000; padding:12px 14px; border-radius:12px; white-space:pre-wrap;}
    @media (max-width:720px){ .grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <h1 style="font-size:44px; font-weight:900; margin:0 0 18px 0;">Проверка автомобиля по VIN</h1>

  <div class="card">
    <input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17"/>
    <div class="row">
      <button id="btn" onclick="checkVin()">Проверить VIN</button>
      <button onclick="clearAll()" style="background:#ff5a2c;">Очистить</button>
    </div>
    <div class="muted">Показываем только нужные поля + маркетинговые метрики (добавим следующим шагом).</div>

    <div class="result" id="out"></div>
  </div>

<script>
function clearAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
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

    // Рисуем красиво (без drive/gear/engine/volume/power)
    out.innerHTML = \`
      <div class="title">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</div>

      <div class="grid">
        <div class="item">
          <div class="label">Комплектация</div>
          <div class="value">\${esc(data.equipmentName)}</div>
        </div>
        <div class="item">
          <div class="label">Модификация</div>
          <div class="value">\${esc(data.modificationName)}</div>
        </div>
        <div class="item">
          <div class="label">Пробег</div>
          <div class="value">\${esc(data.mileage)} км</div>
        </div>
        <div class="item">
          <div class="label">Цвет</div>
          <div class="value">\${esc(data.color)}</div>
        </div>
      </div>

      <!-- Маркетинг добавим на следующем шаге сюда же -->
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

// ===== API: check vin (возвращаем только нужные поля) =====
app.get("/check-vin", async (req, res) => {
  const vin = (req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok: false, message: "VIN is required" });

  try {
    const token = await getToken();

    const carResponse = await http.get(
      "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      {
        params: { vin },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const car = carResponse.data || {};

    // ВАЖНО: отдаём только нужное (и без drive/gear/engine/volume/power)
    return res.json({
      ok: true,
      brand: car.brand || "",
      model: car.model || "",
      year: car.year || "",
      equipmentName: car.equipmentName || "",
      modificationName: car.modificationName || "",
      mileage: car.mileage ?? "",
      color: car.color || "",
      // маркетинг добавим следующим шагом
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const details = error?.response?.data || error?.message || "Unknown error";

    // Если таймаут/внешний API тормозит — лучше честно сказать, чем получить 502 от Railway
    return res.status(502).json({
      ok: false,
      message: "Не удалось получить данные. Попробуйте ещё раз.",
      status,
      details,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
