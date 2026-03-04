const express = require("express");
const axios = require("axios");

const app = express();
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
    body{font-family:Arial, sans-serif; max-width:820px; margin:40px auto; padding:0 16px;}
    .card{border:1px solid #eee; border-radius:14px; padding:22px; box-shadow:0 6px 22px rgba(0,0,0,.06);}
    input{width:100%; padding:14px; font-size:16px; border:1px solid #ddd; border-radius:10px;}
    button{margin-top:12px; padding:14px 18px; font-size:16px; border:none; border-radius:10px; background:#ff5a2c; color:#fff; cursor:pointer;}
    button:disabled{opacity:.6; cursor:not-allowed;}
    pre{white-space:pre-wrap; word-break:break-word; background:#0b1020; color:#d7e1ff; padding:14px; border-radius:12px; overflow:auto;}
    .row{display:flex; gap:10px; margin-top:12px;}
    .muted{color:#666; font-size:14px; margin-top:8px;}
  </style>
</head>
<body>
  <h1>Проверка автомобиля по VIN</h1>
  <div class="card">
    <input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17"/>
    <div class="row">
      <button id="btn" onclick="checkVin()">Проверить VIN</button>
      <button onclick="document.getElementById('vin').value='';document.getElementById('out').textContent='';">Очистить</button>
    </div>
    <div class="muted">Данные берутся из вашего API. Если VIN неверный — покажем ошибку.</div>
    <h3>Результат</h3>
    <pre id="out"></pre>
  </div>

<script>
async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.textContent = 'Введите VIN'; return; }

  btn.disabled = true;
  out.textContent = 'Запрос...';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();
    out.textContent = JSON.stringify(data, null, 2);
  }catch(e){
    out.textContent = 'Ошибка: ' + e.message;
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
  const vin = req.query.vin;
  if (!vin) return res.status(400).json({ error: "VIN is required" });

  try {
    const tokenResponse = await axios.post(
      "https://lk.cm.expert/oauth/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const token = tokenResponse.data.access_token;

    const carResponse = await axios.get(
      `https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car?vin=${encodeURIComponent(vin)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json(carResponse.data);
  } catch (error) {
    // покажем полезнее, чем просто message
    const status = error?.response?.status;
    const data = error?.response?.data;
    res.status(500).json({
      error: "API request failed",
      status,
      details: data || error.message,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
