const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 20000,
});

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(200);
  next();
});

function toISODate(d){
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth()+1).padStart(2,"0");
  const dd = String(x.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(date,days){
  const d = new Date(date);
  d.setDate(d.getDate()+days);
  return d;
}

let tokenCache = {
  token:null,
  expiresAt:0
};

async function getToken(){

  const now = Date.now();

  if(tokenCache.token && now < tokenCache.expiresAt-10000){
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
  tokenCache.expiresAt = Date.now() + r.data.expires_in*1000;

  return tokenCache.token;
}

async function fetchMarketing({token,dealerId,startDate,endDate,siteSource=null}){

  const dealerIdNum = Number(dealerId);

  const r = await http.post(
    "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars",
    {
      grouping:"periodDay",
      dealerIds:[dealerIdNum],
      siteSource,
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

app.get("/",(req,res)=>{

res.send(`

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>VIN аналитика</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>

body{
font-family:Arial;
background:#f4f6fb;
padding:40px;
}

.container{
max-width:1100px;
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

button{
padding:10px 14px;
border-radius:8px;
border:none;
background:#ff5a2c;
color:white;
cursor:pointer;
}

</style>

</head>

<body>

<div class="container">

<h1>Проверка автомобиля по VIN</h1>

<div class="card">

<input id="vin" style="width:100%;padding:12px" placeholder="VIN">

<br><br>

<button onclick="checkVin()">Проверить</button>

</div>

<div id="result"></div>

</div>

<script>

let chart=null

function format(x){
return Number(x||0).toLocaleString("ru-RU")
}

async function checkVin(){

const vin=document.getElementById("vin").value

const r=await fetch("/check-vin?vin="+vin)
const data=await r.json()

if(!data.ok){
alert(data.message)
return
}

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

loadMarketing(data.dealerId)

}

async function loadMarketing(dealerId){

const r=await fetch("/marketing?dealerId="+dealerId)
const data=await r.json()

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

<br>

<canvas id="chart"></canvas>

</div>

\`

const labels=m.stats.map(x=>x.date)
const views=m.stats.map(x=>x.views)

const ctx=document.getElementById("chart")

if(chart) chart.destroy()

chart=new Chart(ctx,{
type:"line",
data:{
labels,
datasets:[
{label:"Просмотры",data:views}
]
}
})

}

</script>

</body>
</html>

`);
});

app.get("/check-vin",async(req,res)=>{

try{

const token = await getToken()

const r = await http.get(
"https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
{
params:{vin:req.query.vin},
headers:{Authorization:`Bearer ${token}`}
}
)

const c=r.data

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

app.get("/marketing",async(req,res)=>{

try{

const token=await getToken()

const dealerId=req.query.dealerId

const endDate=toISODate(new Date())
const startDate=toISODate(addDays(new Date(),-30))

const data=await fetchMarketing({
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

app.listen(PORT,"0.0.0.0",()=>{
console.log("Server running on",PORT)
})
