const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// axios instance
const http = axios.create({
  timeout: 20000
});

// ---------------- CORS ----------------

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(200);
  next();
});

// ---------------- HELPERS ----------------

function toISODate(d){
  const x = new Date(d);
  return x.toISOString().slice(0,10);
}

function addDays(date,days){
  const d = new Date(date);
  d.setDate(d.getDate()+days);
  return d;
}

// ---------------- TOKEN CACHE ----------------

let tokenCache = {
  token:null,
  expiresAt:0
};

async function getToken(){

  const now = Date.now();

  if(tokenCache.token && now < tokenCache.expiresAt - 10000){
    return tokenCache.token;
  }

  const r = await http.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type:"client_credentials",
      client_id:process.env.CLIENT_ID,
      client_secret:process.env.CLIENT_SECRET
    }),
    {
      headers:{
        "Content-Type":"application/x-www-form-urlencoded"
      }
    }
  );

  tokenCache.token = r.data.access_token;
  tokenCache.expiresAt = Date.now() + (r.data.expires_in * 1000);

  return tokenCache.token;
}

// ---------------- MARKETING API ----------------

async function fetchMarketing({token,dealerId,startDate,endDate}){

  const r = await http.post(
    "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars",
    {
      grouping:"periodDay",
      dealerIds:[dealerId],
      siteSource:null,
      startDate,
      endDate
    },
    {
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json"
      }
    }
  );

  return r.data;
}

// ---------------- HOME ----------------

app.get("/",(req,res)=>{

res.send(`

<!doctype html>
<html>

<head>

<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>VIN аналитика</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>

body{
font-family:Arial;
background:#f6f7fb;
margin:0;
padding:40px;
}

.container{
max-width:1000px;
margin:auto;
}

.card{
background:white;
border-radius:16px;
padding:24px;
margin-bottom:20px;
box-shadow:0 10px 30px rgba(0,0,0,.05);
}

.grid{
display:grid;
grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
gap:14px;
}

.metric{
background:#fafafa;
padding:16px;
border-radius:10px;
}

.metric .label{
font-size:12px;
color:#777;
}

.metric .value{
font-size:22px;
font-weight:700;
}

.period button{
margin-right:6px;
}

</style>

</head>

<body>

<div class="container">

<h1>Проверка VIN</h1>

<div class="card">

<input id="vin" placeholder="Введите VIN" style="width:100%;padding:10px">

<div style="margin-top:10px">

<button onclick="checkVin()">Проверить VIN</button>
<button onclick="reset()">Очистить</button>

</div>

<div class="period" style="margin-top:10px">

<button onclick="setPeriod(7)">7 дней</button>
<button onclick="setPeriod(30)">30 дней</button>
<button onclick="setPeriod(90)">90 дней</button>

</div>

</div>

<div id="result"></div>

</div>

<script>

let dealerId=null
let period=30
let chart=null

function setPeriod(p){
period=p
if(dealerId){
loadMarketing()
}
}

function reset(){
document.getElementById("vin").value=""
document.getElementById("result").innerHTML=""
dealerId=null
}

function format(x){
return Number(x).toLocaleString("ru-RU")
}

async function checkVin(){

const vin=document.getElementById("vin").value

const r=await fetch("/check-vin?vin="+vin)
const data=await r.json()

if(!data.ok){
alert(data.message)
return
}

dealerId=data.dealerId

document.getElementById("result").innerHTML=\`

<div class="card">

<h2>\${data.brand} \${data.model} \${data.year}</h2>

<div class="grid">

<div class="metric">
<div class="label">Комплектация</div>
<div class="value">\${data.equipmentName||"-"}</div>
</div>

<div class="metric">
<div class="label">Модификация</div>
<div class="value">\${data.modificationName||"-"}</div>
</div>

<div class="metric">
<div class="label">Пробег</div>
<div class="value">\${format(data.mileage)} км</div>
</div>

<div class="metric">
<div class="label">Цвет</div>
<div class="value">\${data.color||"-"}</div>
</div>

</div>

</div>

<div id="marketing"></div>

\`

loadMarketing()

}

async function loadMarketing(){

document.getElementById("marketing").innerHTML="Загрузка..."

const r=await fetch("/marketing?dealerId="+dealerId+"&days="+period)
const data=await r.json()

if(!data.ok){
document.getElementById("marketing").innerHTML="Ошибка загрузки"
return
}

const m=data.marketing

document.getElementById("marketing").innerHTML=\`

<div class="card">

<h3>Маркетинг</h3>

<div class="grid">

<div class="metric">
<div class="label">Просмотры</div>
<div class="value">\${format(m.total.views)}</div>
</div>

<div class="metric">
<div class="label">Чаты</div>
<div class="value">\${format(m.total.chats.total)}</div>
</div>

<div class="metric">
<div class="label">Расходы</div>
<div class="value">\${format(m.total.sumWithBonusesExpenses)} ₽</div>
</div>

</div>

<canvas id="chart"></canvas>

</div>

\`

const labels=m.stats.map(x=>x.date)
const views=m.stats.map(x=>x.views)
const chats=m.stats.map(x=>x.chats?.total||0)

const ctx=document.getElementById("chart")

if(chart) chart.destroy()

chart=new Chart(ctx,{
type:"line",
data:{
labels,
datasets:[
{label:"Просмотры",data:views},
{label:"Чаты",data:chats}
]
}
})

}

</script>

</body>
</html>

`);
});

// ---------------- VIN ----------------

app.get("/check-vin",async(req,res)=>{

try{

const token = await getToken()

const r = await http.get(
"https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
{
params:{vin:req.query.vin},
headers:{Authorization:\`Bearer \${token}\`}
}
)

const c = r.data

res.json({
ok:true,
brand:c.brand,
model:c.model,
year:c.year,
equipmentName:c.equipmentName,
modificationName:c.modificationName,
mileage:c.mileage,
color:c.color,
dealerId:c.dealerId
})

}catch(e){

res.json({
ok:false,
message:e.response?.data?.message || e.message
})

}

})

// ---------------- MARKETING ----------------

app.get("/marketing",async(req,res)=>{

try{

const token = await getToken()

const dealerId = req.query.dealerId
const days = Number(req.query.days || 30)

const startDate = toISODate(addDays(new Date(),-days))
const endDate = toISODate(new Date())

const data = await fetchMarketing({
token,
dealerId,
startDate,
endDate
})

res.json({
ok:true,
marketing:data
})

}catch(e){

res.json({
ok:false,
message:e.response?.data?.message || e.message
})

}

})

// ---------------- START ----------------

app.listen(PORT,"0.0.0.0",()=>{
console.log("Server running on",PORT)
})
