const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({ timeout: 25000 });

// -------------------- CORS --------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------- helpers --------------------
function toISODate(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pickStockCardId(carObj) {
  // 1) прямые поля (самые вероятные)
  const directKeys = ["stockCardId", "stock_card_id", "stockCardID", "stockcardid"];
  for (const k of directKeys) {
    if (carObj && Object.prototype.hasOwnProperty.call(carObj, k)) {
      const n = safeNum(carObj[k]);
      if (n != null) return { value: n, path: k };
    }
  }

  // 2) рекурсивный поиск (на случай вложенных структур)
  const seen = new Set();
  function walk(node, path) {
    if (!node || typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const r = walk(node[i], `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }

    for (const k of directKeys) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const n = safeNum(node[k]);
        if (n != null) return { value: n, path: `${path}.${k}`.replace(/^\./, "") };
      }
    }

    for (const [k, v] of Object.entries(node)) {
      const r = walk(v, `${path}.${k}`.replace(/^\./, ""));
      if (r) return r;
    }
    return null;
  }

  return walk(carObj, "");
}
function normalizeStatsEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  // Вариант 1: entry.total содержит поля
  if (entry.total && typeof entry.total === "object") return entry.total;

  // Вариант 2: поля лежат прямо в entry (на разных версиях swagger так бывает)
  const maybe = {};
  const keys = [
    "views",
    "promotionExpenses",
    "promotionBonusesExpenses",
    "placementExpenses",
    "callsExpenses",
    "chatsExpenses",
    "tariffsExpenses",
    "sumExpenses",
    "sumWithBonusesExpenses",
    "chats",
  ];
  let found = false;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(entry, k)) {
      maybe[k] = entry[k];
      found = true;
    }
  }
  return found ? maybe : null;
}

// -------------------- token cache --------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) return tokenCache.token;

  const tokenResponse = await http.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = tokenResponse.data.access_token;
  const expiresIn = Number(tokenResponse.data.expires_in || 3600);
  tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

// -------------------- marketing API (по доке) --------------------
async function fetchMarketingStockCars({ token, dealerId, siteSource, startDate, endDate }) {
  // По твоему Swagger:
  // grouping: enum включает "stockCardId" и "periodDay"
  // dealerIds: Array[integer] (min 1)
  // siteSource: null | "auto.ru" | "avito.ru" | "drom.ru"
  // startDate/endDate: YYYY-MM-DD, startDate минимум -31 день от endDate

  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping: "stockCardId",
    dealerIds: [Number(dealerId)],
    siteSource: siteSource ?? null,
    startDate,
    endDate,
  };

  const r = await http.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // важно: если API вернет HTML/ошибку прокси — поймаем как текст в catch ниже
    responseType: "json",
    validateStatus: () => true,
  });

  if (r.status >= 200 && r.status < 300) {
    return { ok: true, data: r.data, request: { url, body } };
  }

  // иногда API может вернуть html в data как строку — дадим понятную ошибку
  const details =
    (typeof r.data === "string" ? r.data.slice(0, 400) : r.data?.message || r.data?.error) ||
    `HTTP ${r.status}`;

  return { ok: false, error: "Marketing API error", status: r.status, details, request: { url, body } };
}

function extractPerCarTotal(marketingData, stockCardId) {
  const stats = Array.isArray(marketingData?.stats) ? marketingData.stats : [];
  const idNum = Number(stockCardId);

  // groupBy в доке — значение, по которому сгруппировано. Для grouping stockCardId там будет stockCardId.
  const row =
    stats.find((x) => Number(x?.groupBy) === idNum) ||
    stats.find((x) => String(x?.groupBy) === String(stockCardId));

  if (!row) return null;

  return normalizeStatsEntry(row);
}

// -------------------- logo: /logo --------------------
const AUTOPORTRAIT_LOGO_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAoHBwgHBhYICAgWFhYVGBcaGBUYGSAeGhcYHRkdHRkfHx8jIi0lHx4oHh8XJTUlKS0vMjIyHSI4PTcwPS4xMi8BCgoKDg0OGxAQGy0lICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAWgB4AMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAUCBgEHAf/EADoQAAIBAgQDBgMGBwAAAAAAAAECAwQRAAUSITFBBhMiUWEHFDKBkaGxByNCUmLB0SNTYoKy8RVDc4L/xAAYAQADAQEAAAAAAAAAAAAAAAAAAQAFAgP/xAAgEQADAQEBAAIDAQAAAAAAAAAAAQIRAyESMQQiQVFh/9oADAMBAAIRAxEAPwD1yAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=";

app.get("/logo", (req, res) => {
  const img = Buffer.from(AUTOPORTRAIT_LOGO_B64, "base64");
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(img);
});

// -------------------- routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Автопортрет · VIN-проверка</title>
  <style>
    :root{
      --card:#ffffff; --text:#0b1220; --muted:#667085; --line:rgba(17, 24, 39, .08);
      --brand:#0a3f47; --brand2:#0f6b77; --accent:#ff5a2c; --ok:#12b76a;
      --shadow: 0 18px 50px rgba(2, 6, 23, .10); --radius: 18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color:var(--text);
      background:
        radial-gradient(900px 420px at 20% -10%, rgba(15,107,119,.35) 0%, rgba(15,107,119,0) 60%),
        radial-gradient(800px 520px at 90% 0%, rgba(255,90,44,.20) 0%, rgba(255,90,44,0) 55%),
        linear-gradient(180deg, #f6f8fb 0%, #f3f6fb 100%);
    }
    .wrap{max-width:1120px; margin:34px auto; padding:0 16px;}
    .topbar{display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px;}
    .brand{display:flex; align-items:center; gap:12px;}
    .logo{width:42px; height:42px; border-radius:12px; box-shadow: 0 10px 22px rgba(10,63,71,.18); overflow:hidden; background:#08333a; display:flex; align-items:center; justify-content:center;}
    .logo img{width:100%; height:100%; object-fit:cover;}
    .brandText{line-height:1.05}
    .brandText .name{font-size:14px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; color:var(--brand);}
    .brandText .sub{font-size:12px; color:var(--muted); margin-top:4px}
    .badge{font-size:12px; color:#0b1220; background:rgba(15,107,119,.10); border:1px solid rgba(15,107,119,.18); padding:8px 10px; border-radius:999px; display:flex; align-items:center; gap:8px; white-space:nowrap;}
    .dot{width:8px; height:8px; border-radius:999px; background:var(--ok);}
    .card{background:var(--card); border:1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);}
    .hero{padding:18px; display:flex; gap:14px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap;}
    .heroLeft h1{margin:0; font-size:34px; letter-spacing:-.02em;}
    .heroLeft p{margin:8px 0 0; color:var(--muted); font-size:14px; max-width:760px; line-height:1.45;}
    .search{margin-top:14px; padding:16px;}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center}
    .input{flex:1; min-width:280px; padding:14px 14px; border-radius:14px; border:1px solid rgba(17,24,39,.10); outline:none; font-size:16px; background:linear-gradient(180deg,#fff 0%, #fbfbfd 100%); box-shadow: 0 1px 0 rgba(17,24,39,.03); transition:.15s;}
    .input:focus{border-color: rgba(15,107,119,.45); box-shadow: 0 0 0 4px rgba(15,107,119,.10);}
    .btn{padding:12px 16px; border-radius:14px; border:none; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:10px;}
    .btn-primary{background: linear-gradient(180deg, #ff6b43 0%, #ff4f1f 100%); color:#fff; box-shadow: 0 10px 24px rgba(255,90,44,.28);}
    .btn-ghost{background:#f2f4f7; color:#111827;}
    .btn:disabled{opacity:.6; cursor:not-allowed; box-shadow:none}
    .hint{margin-top:10px; color:var(--muted); font-size:13px; display:flex; gap:10px; align-items:center;}
    .hint b{color:var(--brand); font-weight:900}
    #out{margin-top:16px}
    .resultHeader{padding:18px;}
    .titleRow{display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:flex-start;}
    .carTitle{font-size:32px; font-weight:950; margin:0; letter-spacing:-.02em;}
    .meta{margin-top:6px; color:var(--muted); font-size:13px; display:flex; gap:14px; flex-wrap:wrap; align-items:center;}
    .pill{display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; background:rgba(10,63,71,.06); border:1px solid rgba(10,63,71,.10); color:#0b1220; font-size:12px;}
    .pill .k{color:var(--muted)}
    .divider{height:1px; background:var(--line); margin:16px 0 0}
    .grid{display:grid; grid-template-columns:repeat(12,1fr); gap:12px; padding:16px 18px 18px;}
    .kpi{grid-column:span 3; border:1px solid var(--line); border-radius:16px; padding:14px; background: radial-gradient(600px 120px at 0% 0%, rgba(15,107,119,.10) 0%, rgba(15,107,119,0) 65%), linear-gradient(180deg,#fff 0%, #fbfbfd 100%);}
    .kpi .label{color:var(--muted); font-size:12px; margin-bottom:8px}
    .kpi .value{font-size:18px; font-weight:950; letter-spacing:-.01em}
    .kpi .value.big{font-size:22px}
    @media(max-width:960px){.kpi{grid-column:span 6}}
    @media(max-width:560px){.kpi{grid-column:span 12}.carTitle{font-size:26px}.heroLeft h1{font-size:28px}}
    .section{padding:0 18px 18px;}
    .sectionTitle{margin:4px 0 10px; font-size:15px; font-weight:950; letter-spacing:.02em; text-transform:uppercase; color:rgba(11,18,32,.80); display:flex; align-items:center; gap:10px;}
    .sectionTitle:before{content:""; width:10px; height:10px; border-radius:4px; background: linear-gradient(180deg, var(--brand2) 0%, var(--brand) 100%); box-shadow: 0 8px 18px rgba(15,107,119,.25);}
    .marketingGrid{display:grid; grid-template-columns:repeat(12,1fr); gap:12px; margin-top:10px;}
    .metric{grid-column:span 3; border:1px solid var(--line); border-radius:16px; padding:14px; background:#fff;}
    .metric .label{color:var(--muted); font-size:12px; margin-bottom:6px}
    .metric .value{font-size:22px; font-weight:950}
    .metric .subv{margin-top:6px; color:var(--muted); font-size:12px; line-height:1.35}
    @media(max-width:960px){.metric{grid-column:span 6}}
    @media(max-width:560px){.metric{grid-column:span 12}}
    .sources{display:grid; grid-template-columns:repeat(12,1fr); gap:12px; margin-top:12px;}
    .srcCard{grid-column:span 4; border:1px solid var(--line); border-radius:16px; padding:14px; background: radial-gradient(500px 120px at 10% 0%, rgba(255,90,44,.10) 0%, rgba(255,90,44,0) 55%), linear-gradient(180deg,#fff 0%, #fbfbfd 100%);}
    @media(max-width:960px){.srcCard{grid-column:span 6}}
    @media(max-width:560px){.srcCard{grid-column:span 12}}
    .srcTop{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px}
    .srcName{font-weight:950; letter-spacing:-.01em}
    .srcBadge{font-size:11px; padding:6px 10px; border-radius:999px; background:rgba(10,63,71,.06); border:1px solid rgba(10,63,71,.10); color:rgba(11,18,32,.85); white-space:nowrap;}
    .kv{display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px dashed rgba(17,24,39,.10)}
    .kv:first-of-type{border-top:none}
    .kv .k{color:var(--muted); font-size:12px}
    .kv .v{font-weight:900; font-size:13px}
    .error{padding:14px 16px; border-radius:16px; border:1px solid rgba(240,68,56,.25); background:rgba(240,68,56,.07); color:#7a271a; font-weight:800;}
    .details{margin-top:10px; padding:12px 14px; border-radius:14px; background:rgba(240,68,56,.06); border:1px solid rgba(240,68,56,.16); color:#7a271a; font-size:12px; white-space:pre-wrap; font-weight:600;}
    .skeleton{padding:18px; color:var(--muted); font-weight:800;}
    .footer{margin-top:14px; padding:14px 0 0; color:rgba(102,112,133,.92); font-size:12px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;}
    .footer b{color:var(--brand)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="logo"><img alt="Автопортрет" src="/logo"/></div>
        <div class="brandText">
          <div class="name">Автопортрет</div>
          <div class="sub">Проверка автомобиля по VIN · Маркетинг (по stockCardId)</div>
        </div>
      </div>
      <div class="badge"><span class="dot"></span> API online · период: последние 30 дней</div>
    </div>

    <div class="card hero">
      <div class="heroLeft">
        <h1>VIN-проверка</h1>
        <p>Маркетинг получаем по <b>stockCardId</b> (как в инструкции). API ограничивает период ~31 день — используем последние <b>30 дней</b>.</p>
      </div>
    </div>

    <div class="card search">
      <div class="row">
        <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17" />
        <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
        <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
      </div>
      <div class="hint">VIN строго <b>17</b> символов. Период маркетинга: <b>последние 30 дней</b>. Классифайды включены.</div>
    </div>

    <div id="out"></div>

    <div class="footer">
      <div>© <b>Автопортрет</b></div>
      <div>Источник данных: CM.Expert API</div>
    </div>
  </div>

<script>
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}
function formatMileage(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU') + ' км';
}
function formatMoney(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU') + ' ₽';
}
function formatNum(n){
  if(n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if(!Number.isFinite(x)) return String(n);
  return x.toLocaleString('ru-RU');
}
function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}
async function fetchAny(url){
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  return { ok: r.ok, status: r.status, text, json };
}
function srcCard(marketing, key, label){
  const t = marketing?.bySource?.[key]?.total || null;
  if(!t){
    return \`
      <div class="srcCard">
        <div class="srcTop"><div class="srcName">\${esc(label)}</div><div class="srcBadge">нет данных</div></div>
        <div class="kv"><div class="k">Просмотры</div><div class="v">—</div></div>
        <div class="kv"><div class="k">Чаты</div><div class="v">—</div></div>
        <div class="kv"><div class="k">Расходы</div><div class="v">—</div></div>
      </div>\`;
  }
  const ch = t.chats || {};
  const sum = (t.sumWithBonusesExpenses ?? t.sumExpenses);
  return \`
    <div class="srcCard">
      <div class="srcTop"><div class="srcName">\${esc(label)}</div><div class="srcBadge">ok</div></div>
      <div class="kv"><div class="k">Просмотры</div><div class="v">\${formatNum(t.views)}</div></div>
      <div class="kv"><div class="k">Чаты</div><div class="v">\${formatNum(ch.total)}</div></div>
      <div class="kv"><div class="k">Расходы</div><div class="v">\${sum != null ? formatMoney(sum) : '—'}</div></div>
    </div>\`;
}
function renderMarketing(marketing){
  if(!marketing || marketing.ok === false){
    const msg = marketing?.message || 'Маркетинг недоступен';
    const det = marketing?.details ? '<div class="details">' + esc(marketing.details) + '</div>' : '';
    return '<div class="section"><div class="sectionTitle">Маркетинг</div><div class="error">' + esc(msg) + '</div>' + det + '</div>';
  }

  const total = marketing.total || {};
  const chats = total.chats || {};
  const sum = (total.sumWithBonusesExpenses ?? total.sumExpenses);

  return \`
    <div class="section">
      <div class="sectionTitle">Маркетинг</div>
      <div class="meta">
        <span class="pill"><span class="k">Период</span> <b>\${esc(marketing.period?.startDate)} — \${esc(marketing.period?.endDate)}</b></span>
        <span class="pill"><span class="k">grouping</span> <b>\${esc(marketing.grouping || 'stockCardId')}</b></span>
        <span class="pill"><span class="k">stockCardId</span> <b>\${esc(marketing.stockCardId ?? '—')}</b></span>
      </div>

      <div class="marketingGrid">
        <div class="metric">
          <div class="label">Просмотры</div>
          <div class="value">\${formatNum(total.views)}</div>
          <div class="subv">По конкретной карточке.</div>
        </div>
        <div class="metric">
          <div class="label">Чаты</div>
          <div class="value">\${formatNum(chats.total)}</div>
          <div class="subv">Пропущено: <b>\${formatNum(chats.missed)}</b> · Платные: <b>\${formatNum(chats.targeted)}</b></div>
        </div>
        <div class="metric">
          <div class="label">Расходы всего (с бонусами)</div>
          <div class="value">\${sum != null ? formatMoney(sum) : '—'}</div>
          <div class="subv">Суммарно по карточке.</div>
        </div>
        <div class="metric">
          <div class="label">Структура расходов</div>
          <div class="value" style="font-size:16px; line-height:1.35">
            \${total.placementExpenses != null ? formatMoney(total.placementExpenses) : '—'} · размещение<br/>
            \${total.callsExpenses != null ? formatMoney(total.callsExpenses) : '—'} · звонки<br/>
            \${total.chatsExpenses != null ? formatMoney(total.chatsExpenses) : '—'} · чаты<br/>
            \${total.tariffsExpenses != null ? formatMoney(total.tariffsExpenses) : '—'} · тариф
          </div>
        </div>
      </div>

      <div class="sectionTitle" style="margin-top:18px">Классифайды</div>
      <div class="sources">
        \${srcCard(marketing,'auto.ru','auto.ru')}
        \${srcCard(marketing,'avito.ru','avito.ru')}
        \${srcCard(marketing,'drom.ru','drom.ru')}
      </div>
    </div>\`;
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){
    out.innerHTML = '<div class="card resultHeader"><div class="error">Введите VIN</div></div>';
    return;
  }
  if(vin.length !== 17){
    out.innerHTML = '<div class="card resultHeader"><div class="error">VIN должен быть 17 символов</div></div>';
    return;
  }

  btn.disabled = true;
  out.innerHTML = '<div class="card"><div class="skeleton">Ищем автомобиль и маркетинг…</div></div>';

  try{
    const resp = await fetchAny('/check-vin?vin=' + encodeURIComponent(vin));
    if(!resp.json){
      out.innerHTML = '<div class="card resultHeader"><div class="error">Сервер вернул НЕ JSON (status '+resp.status+')</div><div class="details">'+esc(resp.text.slice(0,900))+'</div></div>';
      return;
    }

    const data = resp.json;
    if(!resp.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="card resultHeader"><div class="error">' + esc(msg) + '</div></div>';
      return;
    }

    out.innerHTML = \`
      <div class="card">
        <div class="resultHeader">
          <div class="titleRow">
            <div>
              <h2 class="carTitle">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</h2>
              <div class="meta">
                <span class="pill"><span class="k">VIN</span> <b>\${esc(vin)}</b></span>
                <span class="pill"><span class="k">dealerId</span> <b>\${esc(data.dealerId ?? '—')}</b></span>
                <span class="pill"><span class="k">stockCardId</span> <b>\${esc(data.stockCardId ?? '—')}</b></span>
              </div>
            </div>
          </div>
          <div class="divider"></div>
        </div>

        <div class="grid">
          <div class="kpi"><div class="label">Комплектация</div><div class="value">\${esc(data.equipmentName || '—')}</div></div>
          <div class="kpi"><div class="label">Модификация</div><div class="value">\${esc(data.modificationName || '—')}</div></div>
          <div class="kpi"><div class="label">Пробег</div><div class="value big">\${esc(formatMileage(data.mileage))}</div></div>
          <div class="kpi"><div class="label">Цвет</div><div class="value">\${esc(data.color || '—')}</div></div>
        </div>

        \${renderMarketing(data.marketing)}
      </div>
    \`;
  }catch(e){
    out.innerHTML = '<div class="card resultHeader"><div class="error">Ошибка: ' + esc(e.message) + '</div></div>';
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// VIN -> авто + маркетинг по stockCardId
app.get("/check-vin", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  try {
    const token = await getToken();

    // 1) авто по VIN
    const carResponse = await http.get("https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car", {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    });

    const c = carResponse.data || {};
    const dealerId = c.dealerId ?? null;

    // 2) stockCardId (ключ для правильной выборки из marketing.stats[])
    const foundStockCard = pickStockCardId(c);
    const stockCardId = foundStockCard?.value ?? null;

    // период строго 30 дней (по доке)
    const endDate = toISODate(new Date());
    const startDate = toISODate(addDays(new Date(), -30));

    let marketing = { ok: false, message: "Маркетинг не удалось получить" };

    if (!dealerId) {
      marketing = { ok: false, message: "Нет dealerId в ответе — маркетинг не запросить" };
    } else if (!stockCardId) {
      marketing = {
        ok: false,
        message: "Не найден stockCardId в ответе find-last-by-car — по доке он нужен для группировки",
        details: "Проверь, что find-last-by-car возвращает stockCardId (иногда он вложен).",
      };
    } else {
      // базовый маркетинг (siteSource: null) + классифайды
      const sources = [null, "auto.ru", "avito.ru", "drom.ru"];
      const results = await Promise.all(
        sources.map((s) =>
          fetchMarketingStockCars({
            token,
            dealerId,
            siteSource: s,
            startDate,
            endDate,
          })
        )
      );

      const base = results[0];
      if (!base.ok) {
        marketing = {
          ok: false,
          message: "Маркетинг не удалось получить",
          details: base.details || base.error || "Unknown",
        };
      } else {
        // ВНИМАНИЕ: берём НЕ total, а строку из stats[] по groupBy==stockCardId
        const perCarTotal = extractPerCarTotal(base.data, stockCardId);

        // классифайды: то же самое
        const bySource = {};
        const srcKeys = ["auto.ru", "avito.ru", "drom.ru"];
        for (let i = 0; i < srcKeys.length; i++) {
          const rr = results[i + 1];
          if (rr.ok) {
            bySource[srcKeys[i]] = {
              ok: true,
              total: extractPerCarTotal(rr.data, stockCardId),
            };
          } else {
            bySource[srcKeys[i]] = { ok: false, total: null };
          }
        }

        marketing = {
          ok: true,
          grouping: "stockCardId",
          period: { startDate, endDate },
          stockCardId,
          total: perCarTotal, // <-- правильные данные по карточке
          bySource,
          debug: {
            stockCardIdFoundAt: foundStockCard?.path || null,
            note: "total взят из data.stats[] (groupBy==stockCardId), а не из data.total",
          },
        };
      }
    }

    return res.send(
      JSON.stringify({
        ok: true,
        brand: c.brand,
        model: c.model,
        year: c.year,
        equipmentName: c.equipmentName,
        modificationName: c.modificationName,
        mileage: c.mileage,
        color: c.color,
        dealerId,
        stockCardId,
        marketing,
      })
    );
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;

    return res.status(status).send(
      JSON.stringify({
        ok: false,
        error: "API request failed",
        status,
        message: data?.message || data?.error || error.message,
      })
    );
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
