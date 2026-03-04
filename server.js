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

body{
font-family:Arial;
background:#f5f6f7;
padding:40px;
}

.card{
background:white;
padding:30px;
border-radius:14px;
box-shadow:0 10px 25px rgba(0,0,0,0.08);
max-width:800px;
margin:auto;
}

input{
width:100%;
padding:14px;
font-size:16px;
border-radius:10px;
border:1px solid #ddd;
}

button{
margin-top:12px;
padding:14px 20px;
background:#ff5a2c;
color:white;
border:none;
border-radius:10px;
font-size:16px;
cursor:pointer;
}

button:disabled{
opacity:.6;
cursor:not-allowed;
}

.result{
margin-top:25px;
background:#fafafa;
padding:20px;
border-radius:12px;
}

.row{
margin:6px 0;
font-size:16px;
}

.title{
font-size:26px;
font-weight:700;
margin-bottom:15px;
}

</style>

</head>

<body>

<div class="card">

<h1>Проверка автомобиля по VIN</h1>

<input id="vin" placeholder="Введите VIN (17 символов)" maxlength="17"/>

<button id="btn" onclick="checkVin()">Проверить VIN</button>

<div id="result"></div>

</div>

<script>

async function checkVin(){

const vin = document.getElementById("vin").value.trim();
const btn = document.getElementById("btn");
const result = document.getElementById("result");

if(!vin){
result.innerHTML = "Введите VIN";
return;
}

btn.disabled = true;
result.innerHTML = "Проверяем...";

try{

const r = await fetch("/check-vin?vin="+encodeURIComponent(vin));
const data = await r.json();

if(data.error){
result.innerHTML = "Ошибка: "+data.error;
btn.disabled = false;
return;
}

result.innerHTML = \`

<div class="result">

<div class="title">
\${data.brand} \${data.model} \${data.year}
</div>

<div class="row"><b>Комплектация:</b> \${data.equipment}</div>
<div class="row"><b>Модификация:</b> \${data.modification}</div>

<div class="row"><b>Пробег:</b> \${data.mileage} км</div>
<div class="row"><b>Цвет:</b> \${data.color}</div>

<br>

<div class="row"><b>Привод:</b> \${data.drive}</div>
<div class="row"><b>КПП:</b> \${data.gear}</div>
<div class="row"><b>Топливо:</b> \${data.engine}</div>
<div class="row"><b>Объём:</b> \${data.volume} л</div>
<div class="row"><b>Мощность:</b> \${data.power} л.с.</div>

</div>

\`;

}catch(e){

result.innerHTML = "Ошибка запроса";

}

btn.disabled = false;

}

</script>

</body>
</html>
`);
});

// VIN API
app.get("/check-vin", async (req, res) => {

const vin = req.query.vin;

if (!vin)
return res.status(400).json({ error: "VIN is required" });

try {

const tokenResponse = await axios.post(
"https://lk.cm.expert/oauth/token",
new URLSearchParams({
grant_type: "client_credentials",
client_id: process.env.CLIENT_ID,
client_secret: process.env.CLIENT_SECRET
}),
{
headers: {
"Content-Type": "application/x-www-form-urlencoded"
}
}
);

const token = tokenResponse.data.access_token;

const carResponse = await axios.get(
"https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
{
params: { vin: vin },
headers: {
Authorization: \`Bearer \${token}\`
}
}
);

const car = carResponse.data;

// возвращаем только нужные поля
res.json({

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
power: car.power

});

} catch (error) {

res.status(500).json({
error: "API request failed",
details: error?.response?.data || error.message
});

}

});

app.listen(PORT, () =>
console.log("Server running on port " + PORT)
);
