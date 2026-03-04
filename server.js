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
    body{font-family:Arial, sans-serif; max-width:920px; margin:40px auto; padding:0 16px;}
    .card{border:1px solid #eee; border-radius:14px; padding:22px; box-shadow:0 6px 22px rgba(0,0,0,.06); background:#fff;}
    input{width:100%; padding:14px; font-size:16px; border:1px solid #ddd; border-radius:10px;}
    button{margin-top:12px; padding:14px 18px; font-size:16px; border:none; border-radius:10px; background:#ff5a2c; color:#fff; cursor:pointer;}
    button.secondary{background:#f1f1f1; color:#111;}
    button:disabled{opacity:.6; cursor:not-allowed;}
    .row{display:flex; gap:10px; margin-top:12px; flex-wrap:wrap;}
    .muted{color:#666; font-size:14px; margin-top:8px;}
    .error{color:#b00020; background:#fff1f1; border:1px solid #ffd2d2; padding:12px; border-radius:10px; margin-top:14px; white-space:pre-wrap;}
    .result{margin-top:16px; padding:18px; background:#fafafa; border-radius:12px; border:1px solid #eee;}
    .title{font-size:26px; font-weight:800; margin:0 0 10px;}
    .kv{margin:6px 0; font-size:16px;}
    .kv b{display:inline-block; min-width:150px;}
    .divider{height:1px; background:#e9e9e9; margin:14px 0;}
    .loading{margin-top:14px; color:#333;}
  </style>
</head>
<body>
  <h1>Проверка автомобиля по VIN</h1>

  <div class="card">
    <input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17" />
    <div class="row">
      <button id="btn" onclick="checkVin()">Проверить VIN</button>
      <button class="secondary" onclick="clearAll()">Очистить</button>
    </div>
    <div class="muted">Данные берутся из вашего API. Если VIN неверный — покажем ошибку.</div>

    <div id="status" class="loading" style="display:none;"></div>
    <div id="out"></div>
  </div>

<script>
function clearAll(){
  document.getElementById('vin').value = '';
  document.getElementById('out').innerHTML = '';
  document.getElementById('status').style.display = 'none';
  document.getElementById('status').textContent = '';
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function formatMileage(n){
  if (n === null || n === undefined || n === '') return '';
  const x = Number(n);
  if (Number.isNaN(x)) return String(n);
  return x.toLocaleString('ru-RU');
}

function renderCar(data){
  // data уже "короткий" объект из /check-vin
  const brand = esc(data.brand);
  const model = esc(data.model);
  const year = esc(data.year);

  const equipment = esc(data.equipment);
  const modification = esc(data.modification);
  const mileage = esc(formatMileage(data.mileage));
  const color = esc(data.color);

  return \`
    <div class="result">
      <div class="title">\${brand} \${model} \${year}</div>

      <div class="kv"><b>Комплектация:</b> \${equipment}</div>
      <div class="kv"><b>Модификация:</b> \${modification}</div>
      <div class="kv"><b>Пробег:</b> \${mileage} км</div>
      <div class="kv"><b>Цвет:</b> \${color}</div>

      <div class="divider"></div>
      <div class="muted">Маркетинговые метрики добавим следующим шагом (просмотры/классифайды/расходы и т.д.).</div>
    </div>
  \`;
}

function renderError(err){
  // err может быть строкой или объектом
  const text = typeof err === 'string' ? err : JSON.stringify(err, null, 2);
  return \`<div class="error">\${esc(text)}</div>\`;
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');
  const status = document.getElementById('status');

  out.innerHTML = '';
  if(!vin){
    out.innerHTML = renderError('Введите VIN');
    return;
  }

  btn.disabled = true;
  status.style.display = 'block';
  status.textContent = 'Запрос...';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
const data = await r.json();

out.innerHTML = `
<div style="margin-top:20px">

<h2>${data.brand} ${data.model} ${data.year}</h2>

<p><b>Комплектация:</b> ${data.equipment}</p>
<p><b>Модификация:</b> ${data.modification}</p>
<p><b>Пробег:</b> ${data.mileage} км</p>
<p><b>Цвет:</b> ${data.color}</p>

</div>
`;

    // Если сервер вернул ошибку
    if(!r.ok || data?.error){
      status.style.display = 'none';
      out.innerHTML = renderError(data);
      return;
    }

    status.style.display = 'none';
    out.innerHTML = renderCar(data);

  }catch(e){
    status.style.display = 'none';
    out.innerHTML = renderError('Ошибка: ' + e.message);
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>
`);
});

// твой эндпоинт
app.get("/check-vin", async (req, res) => {
  const vin = (req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ error: "VIN is required" });

  try {
    // 1) токен
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

    // 2) авто по VIN
    const carResponse = await axios.get(
      "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      {
        params: { vin },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const car = carResponse.data;

    // 3) отдаем только то, что нужно для красивого UI
    res.json({
      brand: car.brand,
      model: car.model,
      year: car.year,
      equipment: car.equipmentName,
      modification: car.modificationName,
      mileage: car.mileage,
      color: car.color,

      // оставил в ответе как запас (UI их НЕ показывает)
      drive: car.drive,
      gear: car.gear,
      engine: car.engine,
      volume: car.volume,
      power: car.power,
    });

  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;

    res.status(status || 500).json({
      error: "API request failed",
      status: status || 500,
      details: data || error.message,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
