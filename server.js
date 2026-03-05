const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({ timeout: 25000 });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

function isLikelyHtmlBody(data) {
  return typeof data === "string" && data.trim().startsWith("<!DOCTYPE");
}
function clipBody(data, max = 2000) {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, max);
  try {
    const s = JSON.stringify(data);
    return s.length > max ? s.slice(0, max) + "…(clipped)" : s;
  } catch {
    return String(data).slice(0, max);
  }
}

async function safeRequest({ method, url, token, params, body }) {
  const r = await http.request({
    method,
    url,
    params,
    data: body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    validateStatus: () => true,
  });

  const contentType = r.headers?.["content-type"] || null;
  const html = isLikelyHtmlBody(r.data);

  return {
    method,
    url,
    status: r.status,
    contentType,
    isHtml: html,
    ok: r.status >= 200 && r.status < 300 && !html,
    bodyPreview: clipBody(r.data),
    json: !html && typeof r.data === "object" ? r.data : null,
  };
}

function summarizeStockCars(payload) {
  const total = payload?.total || {};
  const chats = total?.chats || {};
  const statsLen = Array.isArray(payload?.stats) ? payload.stats.length : null;

  const anyNonNull = [
    total.views,
    chats.total,
    chats.missed,
    chats.targeted,
    total.sumExpenses,
    total.sumWithBonusesExpenses,
    total.placementExpenses,
    total.callsExpenses,
    total.chatsExpenses,
    total.tariffsExpenses,
    total.promotionExpenses,
    total.promotionBonusesExpenses,
  ].some((v) => v !== null && v !== undefined);

  return { statsLen, anyNonNull, total };
}

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Marketing debug</title>
<style>
body{font-family:Arial,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;}
input{width:100%;padding:12px;font-size:16px;}
button{padding:10px 14px;font-size:14px;margin-top:10px;cursor:pointer;}
pre{white-space:pre-wrap;background:#111;color:#0f0;padding:12px;border-radius:8px;overflow:auto;}
.row{display:flex;gap:10px;align-items:center;margin-top:10px;}
.row button{margin-top:0}
</style></head>
<body>
<h2>Debug маркетинга / прав доступа</h2>
<p>VIN → авто → пробуем stock-cars и проверяем какие ручки дают 403.</p>
<input id="vin" placeholder="VIN (17 символов)" maxlength="17"/>
<div class="row">
  <button onclick="run()">Проверить</button>
  <button onclick="document.getElementById('out').textContent=''">Очистить</button>
</div>
<pre id="out"></pre>
<script>
async function run(){
  const vin = document.getElementById('vin').value.trim();
  const out = document.getElementById('out');
  if(!vin){ out.textContent="Введите VIN"; return; }
  out.textContent="Запрос...";
  const r = await fetch('/debug?vin='+encodeURIComponent(vin), {cache:'no-store'});
  const t = await r.text();
  try{ out.textContent = JSON.stringify(JSON.parse(t), null, 2); }
  catch(e){ out.textContent = "NOT JSON:\\n"+t; }
}
</script>
</body></html>`);
});

app.get("/debug", async (req, res) => {
  res.type("json");
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  try {
    const token = await getToken();

    // авто по VIN
    const carResp = await safeRequest({
      method: "GET",
      url: "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      token,
      params: { vin },
    });

    if (!carResp.ok) {
      return res.status(502).send(JSON.stringify({ ok: false, step: "find-last-by-car", carResp }));
    }

    const car = carResp.json || {};
    const dealerId = car.dealerId ?? null;

    const periods = [
      { name: "last30d", startDate: toISODate(addDays(new Date(), -30)), endDate: toISODate(new Date()) },
      { name: "last31d", startDate: toISODate(addDays(new Date(), -31)), endDate: toISODate(new Date()) },
      { name: "yesterday_to_tomorrow", startDate: toISODate(addDays(new Date(), -1)), endDate: toISODate(addDays(new Date(), 1)) },
    ];

    const out = {
      ok: true,
      vin,
      dealerId,
      carMeta: { brand: car.brand, model: car.model, year: car.year },
      accessMatrix: [],
      stockCarsChecks: [],
    };

    // Матрица доступов (важно для поддержки/CM.Expert)
    const candidates = [
      { method: "GET",  url: "https://lk.cm.expert/api/v1/marketing-statistics" },
      { method: "GET",  url: "https://lk.cm.expert/api/v1/marketing-statistics/summary" },
      { method: "POST", url: "https://lk.cm.expert/api/v1/marketing-statistics/calls" },
      { method: "POST", url: "https://lk.cm.expert/api/v1/marketing-statistics/leads" },
      { method: "POST", url: "https://lk.cm.expert/api/v1/calls/statistics" },
      { method: "POST", url: "https://lk.cm.expert/api/v1/leads/statistics" },
      { method: "POST", url: "https://lk.cm.expert/api/v1/advertising/statistics" },
    ];

    for (const c of candidates) {
      const body = c.method === "POST"
        ? { dealerIds: dealerId ? [Number(dealerId)] : [], startDate: periods[0].startDate, endDate: periods[0].endDate }
        : undefined;

      const r = await safeRequest({ method: c.method, url: c.url, token, body });
      out.accessMatrix.push({
        method: c.method,
        url: c.url,
        status: r.status,
        bodyPreview: r.bodyPreview,
      });
    }

    // Проверки stock-cars по разным периодам + по источникам
    if (dealerId) {
      const sources = [null, "auto.ru", "avito.ru", "drom.ru"];

      for (const p of periods) {
        for (const s of sources) {
          const r = await safeRequest({
            method: "POST",
            url: "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars",
            token,
            body: {
              grouping: "periodDay",
              dealerIds: [Number(dealerId)],
              siteSource: s,
              startDate: p.startDate,
              endDate: p.endDate,
            },
          });

          out.stockCarsChecks.push({
            period: p.name,
            siteSource: s,
            status: r.status,
            ok: r.ok,
            summary: r.ok ? summarizeStockCars(r.json) : null,
            bodyPreview: r.bodyPreview,
          });
        }
      }
    }

    return res.send(JSON.stringify(out));
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    return res.status(status).send(
      JSON.stringify({
        ok: false,
        status,
        message: data?.message || data?.error || error.message,
        raw: data || null,
      })
    );
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
