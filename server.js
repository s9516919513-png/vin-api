const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

// главная страница
app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Проверка авто по VIN</title>
<style>
  body{font-family:Arial; background:#f5f6f7; padding:40px;}
  .card{background:#fff; padding:30px; border-radius:14px; box-shadow:0 10px 25px rgba(0,0,0,.08); max-width:800px; margin:auto;}
  input{width:100%; padding:14px; font-size:16px; border-radius:10px; border:1px solid #ddd;}
  button{margin-top:12px; padding:14px 20px; background:#ff5a2c; color:#fff; border:none; border-radius:10px; font-size:16px; cursor:pointer;}
  button.secondary{background:#ddd; color:#111; margin-left:10px;}
  button:disabled{opacity:.6; cursor:not-allowed;}
  .result{margin-top:25px; background:#fafafa; padding:20px; border-radius:12px;}
  .row{margin:6px 0; font-size:16px;}
  .title{font-size:26px; font-weight:700; margin-bottom:15px;}
  .err{color:#b00020; margin-top:16px; font-weight:600;}
  .muted{color:#666; font-size:14px; margin-top:8px;}
</style>
</head>
<body>

<div class="card">
  <h1>Проверка автомобиля по VIN</h1>

  <input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17"/>

  <div>
    <button id="btn" onclick="checkVin()">Проверить VIN</button>
    <button class="secondary" onclick="clearAll()">Очистить</button>
  </div>

  <div class="muted">Данные берутся из вашего API. Если VIN неверный — покажем ошибку.</div>

  <div id="result"></div>
</div>

<script>
function clearAll(){
  document.getElementById("vin").value = "";
  document.getElementById("result").innerHTML = "";
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, function(m){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]);
  });
}

async function checkVin(){
  var vin = document.getElementById("vin").value.trim();
  var btn = document.getElementById("btn");
  var result = document.getElementById("result");

  if(!vin){
    result.innerHTML = '<div class="err">Введите VIN</div>';
    return;
  }

  btn.disabled = true;
  result.innerHTML = '<div class="muted">Проверяем...</div>';

  try{
    var r = await fetch("/check-vin?vin=" + encodeURIComponent(vin));
    var data = await r.json();

    if(!r.ok || data.error){
      var msg = data && data.error ? data.error : "Ошибка запроса";
      result.innerHTML = '<div class="err">Ошибка: ' + esc(msg) + '</div>';
      btn.disabled = false;
      return;
    }

    // красивый вывод
    var html = '';
    html += '<div class="result">';
    html +=   '<div class="title">' + esc(data.brand) + ' ' + esc(data.model) + ' ' + esc(data.year) + '</div>';
    html +=   '<div class="row"><b>Комплектация:</b> ' + esc(data.equipment) + '</div>';
    html +=   '<div class="row"><b>Модификация:</b> ' + esc(data.modification) + '</div>';
    html +=   '<div class="row"><b>Пробег:</b> ' + esc(data.mileage) + ' км</div>';
    html +=   '<div class="row"><b>Цвет:</b> ' + esc(data.color) + '</div>';
    html +=   '<br>';
    html +=   '<div class="row"><b>Привод:</b> ' + esc(data.drive) + '</div>';
    html +=   '<div class="row"><b>КПП:</b> ' + esc(data.gear) + '</div>';
    html +=   '<div class="row"><b>Топливо:</b> ' + esc(data.engine) + '</div>';
    html +=   '<div class="row"><b>Объём:</b> ' + esc(data.volume) + ' л</div>';
    html +=   '<div class="row"><b>Мощность:</b> ' + esc(data.power) + ' л.с.</div>';
    html += '</div>';

    result.innerHTML = html;

  }catch(e){
    result.innerHTML = '<div class="err">Ошибка: ' + esc(e.message) + '</div>';
  }

  btn.disabled = false;
}
</script>

</body>
</html>
`);
});

// API: VIN
app.get("/check-vin", async (req, res) => {
  const vin = (req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ error: "VIN is required" });

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

    const car = carResponse.data;

    // отдаем только нужное
    return res.json({
      brand: car.brand,
      model: car.model,
      year: car.year,
      equipment: car.equipmentName,
      modification: car.modificationName,
      mileage: car.mileage,
      color: car.color,
      drive: car.drive,
      gear: car.gear,
      engine: car.engine,
      volume: car.volume,
      power: car.power,
    });
  } catch (error) {
    const status = error?.response?.status;
    const details = error?.response?.data || error.message;
    return res.status(500).json({ error: "API request failed", status, details });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
