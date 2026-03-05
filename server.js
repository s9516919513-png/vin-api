const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const http = axios.create({ timeout: 25000 });

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- helpers ----------
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

// Пытаемся найти stockCardId где угодно в объекте машины
function pickStockCardId(carObj) {
  const keys = ["stockCardId", "stock_card_id", "stockCardID", "stockcardid"];
  for (const k of keys) {
    if (carObj && Object.prototype.hasOwnProperty.call(carObj, k)) {
      const n = safeNum(carObj[k]);
      if (n != null) return { value: n, path: k };
    }
  }

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

// Обрезаем большие ответы, чтобы не убивать Railway
function shrink(obj, maxJsonChars = 12000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxJsonChars) return obj;
    return { _truncated: true, jsonChars: s.length, head: s.slice(0, maxJsonChars) };
  } catch (e) {
    return { _unserializable: true, error: String(e?.message || e) };
  }
}

// ---------- token cache ----------
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

// ---------- marketing request ----------
async function callMarketing({ token, dealerId, grouping, siteSource, startDate, endDate }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";
  const body = {
    grouping,
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
    validateStatus: () => true,
  });

  const contentType = r.headers?.["content-type"] || null;

  // Иногда вместо JSON может прийти HTML
  const isLikelyHtml = typeof r.data === "string" && r.data.trim().startsWith("<!DOCTYPE");

  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    contentType,
    request: { url, body },
    isLikelyHtml,
    data: shrink(r.data),
  };
}

function findStatsRowByStockCardId(marketingData, stockCardId) {
  const stats = Array.isArray(marketingData?.stats) ? marketingData.stats : [];
  const idNum = Number(stockCardId);
  return (
    stats.find((x) => Number(x?.groupBy) === idNum) ||
    stats.find((x) => String(x?.groupBy) === String(stockCardId)) ||
    null
  );
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>VIN debug</title>
  <style>
    body{font-family:Arial,sans-serif; max-width:980px; margin:24px auto; padding:0 16px;}
    input{width:100%; padding:12px; font-size:16px;}
    button{padding:10px 14px; font-size:14px; margin-top:10px; cursor:pointer;}
    pre{white-space:pre-wrap; background:#111; color:#0f0; padding:12px; border-radius:8px; overflow:auto;}
    .row{display:flex; gap:10px; align-items:center; margin-top:10px;}
    .row button{margin-top:0}
  </style>
</head>
<body>
  <h2>Диагностика маркетинга</h2>
  <p>Введи VIN и нажми "Проверить". Покажем raw-данные машины и сырые ответы маркетинга (periodDay + stockCardId если найдём).</p>

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

  const r = await fetch('/check?vin=' + encodeURIComponent(vin), { cache: 'no-store' });
  const t = await r.text();
  try{
    const j = JSON.parse(t);
    out.textContent = JSON.stringify(j, null, 2);
  }catch(e){
    out.textContent = "NOT JSON:\\n" + t;
  }
}
</script>
</body>
</html>`);
});

// Главный диагностический эндпоинт
app.get("/check", async (req, res) => {
  res.type("json");

  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).send(JSON.stringify({ ok: false, error: "VIN is required" }));

  const endDate = toISODate(new Date());
  const startDate = toISODate(addDays(new Date(), -30)); // по доке ограничение ~31 день

  try {
    const token = await getToken();

    // 1) car
    const carResp = await http.get("https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car", {
      params: { vin },
      headers: { Authorization: `Bearer ${token}` },
    });

    const car = carResp.data || {};
    const dealerId = car.dealerId ?? null;

    const stock = pickStockCardId(car); // может быть null

    const result = {
      ok: true,
      vin,
      period: { startDate, endDate },
      carMeta: {
        dealerId,
        brand: car.brand,
        model: car.model,
        year: car.year,
      },
      stockCardId: stock?.value ?? null,
      stockCardIdFoundAt: stock?.path ?? null,
      rawCar: shrink(car, 14000),
      marketing: {},
    };

    if (!dealerId) {
      result.marketing.error = "dealerId отсутствует в ответе машины — маркетинг не запросить";
      return res.send(JSON.stringify(result));
    }

    // 2) маркетинг periodDay (агрегат по дилеру)
    const sources = [null, "auto.ru", "avito.ru", "drom.ru"];
    const periodDayCalls = await Promise.all(
      sources.map((s) =>
        callMarketing({
          token,
          dealerId,
          grouping: "periodDay",
          siteSource: s,
          startDate,
          endDate,
        })
      )
    );

    result.marketing.periodDay = {
      base: periodDayCalls[0],
      bySource: {
        "auto.ru": periodDayCalls[1],
        "avito.ru": periodDayCalls[2],
        "drom.ru": periodDayCalls[3],
      },
    };

    // 3) маркетинг stockCardId (если нашли stockCardId)
    if (stock?.value != null) {
      const stockCalls = await Promise.all(
        sources.map((s) =>
          callMarketing({
            token,
            dealerId,
            grouping: "stockCardId",
            siteSource: s,
            startDate,
            endDate,
          })
        )
      );

      // попробуем найти строку в stats именно по этому авто (только для base)
      const baseData = stockCalls[0]?.data;
      let matchedRow = null;

      // baseData может быть shrink-объектом, а не настоящим data. Поэтому пробуем:
      // если не truncated — ищем внутри baseData.stats
      if (baseData && !baseData._truncated && !baseData._unserializable) {
        matchedRow = findStatsRowByStockCardId(baseData, stock.value);
      }

      result.marketing.stockCardId = {
        base: stockCalls[0],
        bySource: {
          "auto.ru": stockCalls[1],
          "avito.ru": stockCalls[2],
          "drom.ru": stockCalls[3],
        },
        matchInBaseStats: matchedRow ? shrink(matchedRow, 8000) : null,
        note:
          matchedRow
            ? "Нашли строку в stats[] по groupBy==stockCardId"
            : "Не нашли строку в stats[] по groupBy==stockCardId (или ответ был слишком большой и был truncated).",
      };
    } else {
      result.marketing.stockCardId = {
        skipped: true,
        reason: "stockCardId не найден в find-last-by-car",
      };
    }

    return res.send(JSON.stringify(result));
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;

    return res.status(status).send(
      JSON.stringify({
        ok: false,
        error: "API request failed",
        status,
        message: data?.message || data?.error || error.message,
        raw: shrink(data),
      })
    );
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
