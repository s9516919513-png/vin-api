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
function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pickFirstIdLike(obj, preferredKeys) {
  // 1) прямые ключи
  for (const k of preferredKeys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = safeNum(obj[k]);
      if (n != null) return { key: k, value: n, path: k };
    }
  }

  // 2) рекурсивный поиск: ищем числовые id по приоритетным именам
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

    // сначала приоритетные ключи на этом уровне
    for (const k of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const n = safeNum(node[k]);
        if (n != null) return { key: k, value: n, path: `${path}.${k}`.replace(/^\./, "") };
      }
    }

    // затем общий обход
    for (const [k, v] of Object.entries(node)) {
      const r = walk(v, `${path}.${k}`.replace(/^\./, ""));
      if (r) return r;
    }

    return null;
  }

  return walk(obj, "");
}

function isEmptyTotal(total) {
  // тотал может быть null или со всеми нулями
  if (!total || typeof total !== "object") return true;

  const views = safeNum(total.views) ?? 0;
  const chatsTotal = safeNum(total?.chats?.total) ?? 0;

  const sum =
    safeNum(total.sumWithBonusesExpenses) ??
    safeNum(total.sumExpenses) ??
    safeNum(total.placementExpenses) ??
    safeNum(total.callsExpenses) ??
    safeNum(total.chatsExpenses) ??
    safeNum(total.tariffsExpenses) ??
    0;

  return views === 0 && chatsTotal === 0 && sum === 0;
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

// -------------------- marketing API --------------------
async function postMarketing({ token, body }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";
  const r = await http.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return r.data;
}

// “за всё время”: пробуем окна и возвращаем первое успешное
async function fetchMarketingAllTimeBase({ token, baseBody }) {
  const end = new Date();
  const windowsDays = [3650, 1825, 1095, 730, 365, 180, 90, 30];
  let lastErr = null;

  for (const days of windowsDays) {
    const start = addDays(end, -days);
    const body = {
      ...baseBody,
      startDate: toISODate(start),
      endDate: toISODate(end),
    };

    try {
      const data = await postMarketing({ token, body });
      return {
        ok: true,
        period: { startDate: body.startDate, endDate: body.endDate, mode: `auto-${days}d` },
        data,
        requestBody: body,
      };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  return {
    ok: false,
    message: "Маркетинг не удалось получить",
    details: lastErr?.response?.data?.message || lastErr?.message || "Unknown error",
    requestBody: baseBody,
  };
}

// Главная магия: пытаемся получить маркетинг именно по 1 машине
async function fetchMarketingForOneCarAllTime({ token, dealerId, siteSource, carFilter }) {
  const dealerIdNum = Number(dealerId);
  const base = {
    grouping: "periodDay",
    dealerIds: [dealerIdNum],
    siteSource: siteSource ?? null,
  };

  // ВАРИАНТЫ ФИЛЬТРА (мы не знаем точное поле из доки, поэтому пробуем несколько)
  // carFilter = { stockCarId?, stockCardId?, carId?, id? }
  const candidates = [];

  // самый вероятный
  if (carFilter?.stockCarId != null) {
    candidates.push({ field: "stockCarIds", value: [Number(carFilter.stockCarId)] });
    candidates.push({ field: "stockCarId", value: Number(carFilter.stockCarId) }); // на случай если API так
  }
  if (carFilter?.stockCardId != null) {
    candidates.push({ field: "stockCardIds", value: [Number(carFilter.stockCardId)] });
    candidates.push({ field: "stockCardId", value: Number(carFilter.stockCardId) });
  }
  if (carFilter?.carId != null) {
    candidates.push({ field: "carIds", value: [Number(carFilter.carId)] });
    candidates.push({ field: "carId", value: Number(carFilter.carId) });
  }
  if (carFilter?.id != null) {
    candidates.push({ field: "ids", value: [Number(carFilter.id)] });
    candidates.push({ field: "id", value: Number(carFilter.id) });
  }

  // 1) если есть кандидаты — пробуем по ним, пока не получим “живой” total
  for (const cand of candidates) {
    const attempt = await fetchMarketingAllTimeBase({
      token,
      baseBody: { ...base, [cand.field]: cand.value },
    });

    if (attempt.ok) {
      const total = attempt.data?.total || null;
      // если total не пустой — считаем что попали в нужный фильтр
      if (!isEmptyTotal(total)) {
        return {
          ok: true,
          period: attempt.period,
          data: attempt.data,
          usedFilter: cand,
          requestBody: attempt.requestBody,
        };
      }
      // total нулевой — возможно не тот ключ, пробуем дальше
    }
  }

  // 2) fallback: если фильтра нет или все не подошли — возвращаем по дилеру, но помечаем как fallback
  const dealerOnly = await fetchMarketingAllTimeBase({ token, baseBody: base });

  return {
    ok: dealerOnly.ok,
    period: dealerOnly.period,
    data: dealerOnly.data,
    usedFilter: null,
    requestBody: dealerOnly.requestBody,
    warning: "Не удалось применить фильтр по конкретному авто — показаны агрегированные данные по дилеру (dealerIds).",
    details: dealerOnly.details,
  };
}

// -------------------- logo: /logo --------------------
const AUTOPORTRAIT_LOGO_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAoHBwgHBhYICAgWFhYVGBcaGBUYGSAeGhcYHRkdHRkfHx8jIi0lHx4oHh8XJTUlKS0vMjIyHSI4PTcwPS4xMi8BCgoKDg0OGxAQGy0lICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAWgB4AMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAUCBgEHAf/EADoQAAIBAgQDBgMGBwAAAAAAAAECAwQRAAUSITFBBhMiUWEHFDKBkaGxByNCUmLB0SNTYoKy8RVDc4L/xAAYAQADAQEAAAAAAAAAAAAAAAAAAQAFAgP/xAAgEQADAQEBAAIDAQAAAAAAAAAAAQIRAyESMQQiQVFh/9oADAMBAAIRAxEAPwD1yAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=";

app.get("/logo", (req, res) => {
  const img = Buffer.from(AUTOPORTRAIT_LOGO_B64, "base64");
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(img);
});

// -------------------- UI --------------------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Автопортрет · Проверка по VIN</title>
  <style>
    :root{
      --card:#ffffff;
      --text:#0b1220;
      --muted:#667085;
      --line:rgba(17, 24, 39, .08);
      --brand:#0a3f47;
      --brand2:#0f6b77;
      --accent:#ff5a2c;
      --ok:#12b76a;
      --shadow: 0 18px 50px rgba(2, 6, 23, .10);
      --radius: 18px;
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
    .warn{padding:12px 14px; border-radius:14px; background:rgba(247,144,9,.10); border:1px solid rgba(247,144,9,.22); color:#7a4b00; font-weight:800; margin-top:10px;}
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
          <div class="sub">Проверка автомобиля по VIN · Маркетинг и классифайды</div>
        </div>
      </div>
      <div class="badge"><span class="dot"></span> API online · маркетинг (по авто, если возможно)</div>
    </div>

    <div class="card hero">
      <div class="heroLeft">
        <h1>VIN-проверка</h1>
        <p>Достаём автомобиль из <b>CM.Expert</b> и пытаемся получить маркетинг <b>по конкретной карточке</b> (а не по всему дилеру). Если API не даёт фильтр — покажем предупреждение.</p>
      </div>
    </div>

    <div class="card search">
      <div class="row">
        <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17" />
        <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить</button>
        <button class="btn btn-ghost" onclick="resetAll()">Очистить</button>
      </div>
      <div class="hint">VIN строго <b>17</b> символов. Графиков нет — только totals + классифайды.</div>
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

  const warn = marketing.warning ? '<div class="warn">' + esc(marketing.warning) + '</div>' : '';
  const filter = marketing.usedFilter ? ('Фильтр: ' + marketing.usedFilter.field + '=' + JSON.stringify(marketing.usedFilter.value)) : 'Фильтр: —';

  return \`
    <div class="section">
      <div class="sectionTitle">Маркетинг</div>
      <div class="meta">
        <span class="pill"><span class="k">Период</span> <b>\${esc(marketing.period?.startDate)} — \${esc(marketing.period?.endDate)}</b></span>
        <span class="pill"><span class="k">Режим</span> <b>\${esc(marketing.period?.mode || 'auto')}</b></span>
        <span class="pill"><span class="k">\${esc(filter)}</span></span>
      </div>
      \${warn}

      <div class="marketingGrid">
        <div class="metric">
          <div class="label">Просмотры</div>
          <div class="value">\${formatNum(total.views)}</div>
          <div class="subv">Суммарно за доступный период.</div>
        </div>

        <div class="metric">
          <div class="label">Чаты</div>
          <div class="value">\${formatNum(chats.total)}</div>
          <div class="subv">Пропущено: <b>\${formatNum(chats.missed)}</b> · Платные: <b>\${formatNum(chats.targeted)}</b></div>
        </div>

        <div class="metric">
          <div class="label">Расходы всего (с бонусами)</div>
          <div class="value">\${sum != null ? formatMoney(sum) : '—'}</div>
          <div class="subv">Итоговый расход.</div>
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

// -------------------- /check-vin --------------------
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

    // 2) пытаемся понять ID карточки/стока в ответе
    // Приоритетные ключи — самые вероятные варианты
    const preferred = ["stockCarId", "stockCardId", "carId", "id", "stock_id", "cardId", "offerId", "advertId"];
    const found = pickFirstIdLike(c, preferred);

    // Собираем структуру фильтра для маркетинга
    const carFilter = {
      stockCarId: c.stockCarId ?? null,
      stockCardId: c.stockCardId ?? null,
      carId: c.carId ?? null,
      id: c.id ?? null,
    };

    // если прямых полей нет — используем то, что нашли рекурсивно, как "id"
    if (carFilter.stockCarId == null && carFilter.stockCardId == null && carFilter.carId == null && carFilter.id == null) {
      if (found?.value != null) carFilter.id = found.value;
    }

    // 3) маркетинг + классифайды (по авто, если получится)
    let marketing = { ok: false, message: "Маркетинг не удалось получить" };

    if (c.dealerId != null) {
      const base = await fetchMarketingForOneCarAllTime({
        token,
        dealerId: c.dealerId,
        siteSource: null,
        carFilter,
      });

      if (base.ok) {
        const sources = ["auto.ru", "avito.ru", "drom.ru"];
        const tasks = sources.map((s) =>
          fetchMarketingForOneCarAllTime({
            token,
            dealerId: c.dealerId,
            siteSource: s,
            carFilter,
          })
        );

        const results = await Promise.allSettled(tasks);

        const bySource = {};
        sources.forEach((s, idx) => {
          const rr = results[idx];
          if (rr.status === "fulfilled" && rr.value?.ok) {
            bySource[s] = { ok: true, total: rr.value?.data?.total || null };
          } else {
            bySource[s] = { ok: false, total: null };
          }
        });

        marketing = {
          ok: true,
          grouping: "periodDay",
          period: base.period,
          total: base.data?.total || null,
          bySource,
          dealerId: Number(c.dealerId),
          usedFilter: base.usedFilter,
          warning: base.warning || null,
          debug: {
            foundId: found || null,
            carFilter,
          },
        };
      } else {
        marketing = base;
      }
    } else {
      marketing = { ok: false, message: "Нет dealerId в ответе — маркетинг не запросить" };
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
        dealerId: c.dealerId ?? null,
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
