const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({ timeout: 25000 });

// ---------------- CORS ----------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------------- helpers ----------------
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
  const keys = ["stockCardId", "stock_card_id", "stockCardID", "stockcardid", "stockCard"];
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

    for (const k of keys) {
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

function summarizeMarketingPayload(payload) {
  const total = payload?.total || {};
  const chats = total?.chats || {};
  const statsLen = Array.isArray(payload?.stats) ? payload.stats.length : null;

  const hasAnyNumber =
    [total.views, chats.total, chats.missed, chats.targeted,
     total.sumExpenses, total.sumWithBonusesExpenses,
     total.placementExpenses, total.callsExpenses, total.chatsExpenses, total.tariffsExpenses]
      .some((v) => v !== null && v !== undefined);

  return {
    statsLen,
    hasAnyNumber,
    total: {
      views: total.views ?? null,
      chats: {
        total: chats.total ?? null,
        missed: chats.missed ?? null,
        targeted: chats.targeted ?? null,
      },
      sumExpenses: total.sumExpenses ?? null,
      sumWithBonusesExpenses: total.sumWithBonusesExpenses ?? null,
      placementExpenses: total.placementExpenses ?? null,
      callsExpenses: total.callsExpenses ?? null,
      chatsExpenses: total.chatsExpenses ?? null,
      tariffsExpenses: total.tariffsExpenses ?? null,
    },
  };
}

// ---------------- token cache ----------------
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

// ---------------- marketing call ----------------
async function callMarketing({ token, dealerIds, grouping, siteSource, startDate, endDate }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping,
    dealerIds,
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
    validateStatus: () => true,
  });

  const contentType = r.headers?.["content-type"] || null;
  const isHtml = typeof r.data === "string" && r.data.trim().startsWith("<!DOCTYPE");

  const payload = isHtml ? null : r.data;
  const summary = payload ? summarizeMarketingPayload(payload) : null;

  return {
    ok: r.status >= 200 && r.status < 300 && !isHtml,
    status: r.status,
    contentType,
    isHtml,
    request: { body },
    summary,
    raw: payload && JSON.stringify(payload).length < 12000 ? payload : { _rawTooBig: true },
  };
}

// ---------------- routes ----------------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Marketing debug</title>
  <style>
    body{font-family:Arial,sans-serif; max-width:1100px; margin:24px auto; padding:0 16px;}
    input{width:100%; padding:12px; font-size:16px;}
    button{padding:10px 14px; font-size:14px; margin-top:10px; cursor:pointer;}
    pre{white-space:pre-wrap; background:#111; color:#0f0; padding:12px; border-radius:8px; overflow:auto;}
    .row{display:flex; gap:10px; align-items:center; margin-top:10px;}
    .row button{margin-top:0}
  </style>
</head>
<body>
  <h2>Диагностика: marketing-statistics/stock-cars</h2>
  <p>Это тестовый режим. Мы перебираем варианты grouping/dealerIds/period/siteSource и смотрим, где появляются НЕ-null totals / НЕ-пустой stats.</p>
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
  if(!vin){ out.textContent = "Введите VIN"; return; }
  out.textContent = "Запрос...";

  const r = await fetch('/debug?vin=' + encodeURIComponent(vin), { cache: 'no-store' });
  const t = await r.text();
  try{
    out.textContent = JSON.stringify(JSON.parse(t), null, 2);
  }catch(e){
    out.textContent = "NOT JSON:\\n" + t;
  }
}
</script>
</body>
</html>`);
});

app.get("/debug", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  const periodA = {
    startDate: toISODate(addDays(new Date(), -30)),
    endDate: toISODate(new Date()),
    label: "last30d",
  };

  // альтернативный период (иногда endDate “не включает” день)
  const periodB = {
    startDate: toISODate(addDays(new Date(), -1)),
    endDate: toISODate(addDays(new Date(), 1)),
    label: "yesterday_to_tomorrow",
  };

  try {
    const token = await getToken();

    const carResp = await http.get("https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car", {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    });

    const car = carResp.data || {};
    const dealerId = car.dealerId ?? null;
    const stock = pickStockCardId(car);

    const out = {
      ok: true,
      vin,
      dealerId,
      stockCardId: stock?.value ?? null,
      stockCardIdFoundAt: stock?.path ?? null,
      carMeta: { brand: car.brand, model: car.model, year: car.year },
      tests: [],
      note:
        "Смотри tests[].summary.hasAnyNumber и tests[].summary.statsLen — где появляется реальная статистика.",
    };

    if (!dealerId) {
      out.ok = false;
      out.error = "dealerId отсутствует в find-last-by-car";
      return res.send(JSON.stringify(out));
    }

    const groupings = ["periodDay", "stockCardId", "stockCard"]; // stockCard на всякий случай
    const dealerIdsVariants = [
      { label: "dealerIds:number", dealerIds: [Number(dealerId)] },
      { label: "dealerIds:string", dealerIds: [String(dealerId)] },
    ];
    const sources = [null, "auto.ru", "avito.ru", "drom.ru"];
    const periods = [periodA, periodB];

    for (const p of periods) {
      for (const g of groupings) {
        for (const dv of dealerIdsVariants) {
          for (const s of sources) {
            const r = await callMarketing({
              token,
              dealerIds: dv.dealerIds,
              grouping: g,
              siteSource: s,
              startDate: p.startDate,
              endDate: p.endDate,
            });

            out.tests.push({
              period: p.label,
              grouping: g,
              dealerIdsVariant: dv.label,
              siteSource: s,
              ok: r.ok,
              status: r.status,
              contentType: r.contentType,
              isHtml: r.isHtml,
              summary: r.summary,
              request: r.request,
              raw: r.raw, // маленький raw, если не огромный
            });
          }
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
