const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// axios
const http = axios.create({ timeout: 20000 });

// CORS
app.use((req,res,next)=>{
res.setHeader("Access-Control-Allow-Origin","*");
res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
if(req.method==="OPTIONS") return res.sendStatus(200);
next();
});

function toISODate(d){
const x=new Date(d);
return x.toISOString().slice(0,10);
}

function addDays(date,days){
const d=new Date(date);
d.setDate(d.getDate()+days);
return d;
}

// ---------------- TOKEN CACHE ----------------

let tokenCache={token:null,expiresAt:0};

async function getToken(){

const now=Date.now();

if(tokenCache.token && now<tokenCache.expiresAt){
return tokenCache.token;
}

const r=await http.post(
"https://lk.cm.expert/oauth/token",
new URLSearchParams({
grant_type:"client_credentials",
client_id:process.env.CLIENT_ID,
client_secret:process.env.CLIENT_SECRET
}),
{headers:{'Content-Type':'application/x-www-form-urlencoded'}}
);

tokenCache={
token:r.data.access_token,
expiresAt:Date.now()+((r.data.expires_in||3600)*1000)
};

return tokenCache.token;
}

// ---------------- MARKETING CACHE ----------------

const marketingCache=new Map();

function cacheGet(key){
const x=marketingCache.get(key);
if(!x) return null;
if(Date.now()>x.exp){
marketingCache.delete(key);
return null;
}
return x.data;
}

function cacheSet(key,data,ttl=600000){
marketingCache.set(key,{data,exp:Date.now()+ttl});
}

// ---------------- MARKETING API ----------------

async function fetchMarketing({token,dealerId,startDate,endDate,siteSource=null}){

const r=await http.post(
"https://lk.cm.expert/api/v1/marketing-statistics/stock-cars",
{
grouping:"periodDay",
dealerIds:[dealerId],
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

// ---------------- MULTI PERIOD ----------------

async function marketingPeriod({token,dealerId,days}){

const end=new Date();
let periods=[];

if(days<=30){

periods.push({
start:toISODate(addDays(end,-days)),
end:toISODate(end)
});

}else{

periods.push({
start:toISODate(addDays(end,-30)),
end:toISODate(end)
});

periods.push({
start:toISODate(addDays(end,-60)),
end:toISODate(addDays(end,-30))
});

periods.push({
start:toISODate(addDays(end,-90)),
end:toISODate(addDays(end,-60))
});

}

let totals={
views:0,
chats:{total:0,missed:0,targeted:0},
sumExpenses:0,
sumWithBonusesExpenses:0
};

let stats=[];

for(const p of periods){

const data=await fetchMarketing({
token,
dealerId,
startDate:p.start,
endDate:p.end
});

if(data.total){

totals.views+=data.total.views||0;
totals.chats.total+=data.total.chats?.total||0;
totals.chats.missed+=data.total.chats?.missed||0;
totals.chats.targeted+=data.total.chats?.targeted||0;

totals.sumExpenses+=data.total.sumExpenses||0;
totals.sumWithBonusesExpenses+=data.total.sumWithBonusesExpenses||0;

}

if(data.stats){
stats.push(...data.stats);
}

}

return {total:totals,stats};
}

// ---------------- HOME ----------------

app.get("/",(req,res)=>{

res.send(`<!DOCTYPE html>
<html lang="ru">
<head>

<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>VIN Аналитика</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>

body{
font-family:Inter,Arial;
background:#f5f6fa;
margin:0;
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
box-shadow:0 10px 30px rgba(0,0,0,.05);
margin-bottom:20px;
}

h1{
font-size:36px;
margin-bottom:20px;
}

.grid{
display:grid;
grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
gap:14px;
}

.metric{
background:#fafafa;
border-radius:12px;
padding:16px;
}

.metric .label{
font-size:13px;
color:#777;
}

.metric .value{
font-size:24px;
font-weight:700;
margin-top:6px;
}

input{
width:100%;
padding:14px;
border-radius:10px;
border:1px solid #ddd;
font-size:16px;
}

button{
padding:12px 16px;
border-radius:10px;
border:none;
font-weight:600;
cursor:pointer;
}

.primary{
background:#ff5a2c;
color:white;
}

.light{
background:#eee;
}

.period{
display:flex;
gap:8px;
margin-top:10px;
}

.period button{
background:#eee;
}

.period button.active{
background:#111;
color:white;
}

.chart{
margin-top:30px;
}

</style>

</head>

<body>

<div class="container">

<h1>Проверка VIN</h1>

<div class="card">

<input id="vin" placeholder="Введите VIN (17 символов)">

<div style="margin-top:10px">

<button class="primary" onclick="checkVin()">Проверить VIN</button>
<button class="light" onclick="reset()">Очистить</button>

</div>

<div class="period">

<button onclick="setPeriod(7)">7 дней</button>
<button class="active" onclick="setPeriod(30)">30 дней</button>
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

document.querySelectorAll(".period button").forEach(b=>b.classList.remove("active"))
event.target.classList.add("active")

if(dealerId) loadMarketing()

}

function reset(){

document.getElementById("vin").value=""
document.getElementById("result").innerHTML=""
dealerId=null

}

function format(x){
return Number(x).toLocaleString("ru-RU")
}

function money(x){
return format(x)+" ₽"
}

async function checkVin(){

const vin=document.getElementById("vin").value

const r=await fetch("/check-vin?vin="+vin)
const d=await r.json()

if(!d.ok){
alert(d.message)
return
}

dealerId=d.dealerId

document.getElementById("result").innerHTML=\`

<div class="card">

<h2>\${d.brand} \${d.model} \${d.year}</h2>

<div class="grid">

<div class="metric">
<div class="label">Комплектация</div>
<div class="value">\${d.equipmentName||"—"}</div>
</div>

<div class="metric">
<div class="label">Модификация</div>
<div class="value">\${d.modificationName||"—"}</div>
</div>

<div class="metric">
<div class="label">Пробег</div>
<div class="value">\${format(d.mileage)} км</div>
</div>

<div class="metric">
<div class="label">Цвет</div>
<div class="value">\${d.color||"—"}</div>
</div>

</div>

</div>

<div id="marketing"></div>

\`

loadMarketing()

}

async function loadMarketing(){

document.getElementById("marketing").innerHTML="Загрузка маркетинга..."

const r=await fetch("/marketing?dealerId="+dealerId+"&days="+period)
const d=await r.json()

if(!d.ok){
document.getElementById("marketing").innerHTML="Ошибка маркетинга"
return
}

const m=d.marketing

document.getElementById("marketing").innerHTML=\`

<div class="card">

<h3>Маркетинг за \${period} дней</h3>

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
<div class="value">\${money(m.total.sumWithBonusesExpenses)}</div>
</div>

</div>

<canvas id="chart" class="chart"></canvas>

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
{
label:"Просмотры",
data:views
},
{
label:"Чаты",
data:chats
}
]
}
})

}

</script>

</body>
</html>`);
});

// ---------------- VIN ----------------

app.get("/check-vin",async(req,res)=>{

const vin=req.query.vin;

try{

const token=await getToken();

const r=await http.get(
"https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
{
params:{vin},
headers:{Authorization:\`Bearer \${token}\`}
}
);

const c=r.data;

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
});

}catch(e){

res.json({
ok:false,
message:e.response?.data?.message||e.message
});

}

});

// ---------------- MARKETING ----------------

app.get("/marketing",async(req,res)=>{

const dealerId=req.query.dealerId;
const days=Number(req.query.days||30);

const key=dealerId+"_"+days;

const cached=cacheGet(key);
if(cached){
return res.json({ok:true,marketing:cached});
}

try{

const token=await getToken();

const data=await marketingPeriod({
token,
dealerId,
days
});

cacheSet(key,data);

res.json({ok:true,marketing:data});

}catch(e){

res.json({
ok:false,
message:e.response?.data?.message||e.message
});

}

});

app.listen(PORT,()=>console.log("Server running "+PORT));
