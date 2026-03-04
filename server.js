// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ---------------- helpers ---------------- */
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

// из ответа marketing-statistics выбираем строку по конкретной карточке
function pickStatByStockCardId(payload, stockCardId) {
  if (!payload) return null;

  // чаще всего приходит { total: {...}, stats: [...] }
  const stats = Array.isArray(payload.stats) ? payload.stats : [];
  const found = stats.find((x) => String(x.groupBy) === String(stockCardId));
  if (!found) return null;

  // у строки может быть total внутри
  return found.total || found;
}

function normalizeMarketingTotal(total) {
  if (!total) return null;
  const chats = total.chats || {};
  return {
    views: total.views ?? null,
    chats: {
      total: chats.total ?? null,
      missed: chats.missed ?? null,
      targeted: chats.targeted ?? null,
    },
    promotionExpenses: total.promotionExpenses ?? null,
    promotionBonusesExpenses: total.promotionBonusesExpenses ?? null,
    placementExpenses: total.placementExpenses ?? null,
    callsExpenses: total.callsExpenses ?? null,
    chatsExpenses: total.chatsExpenses ?? null,
    tariffsExpenses: total.tariffsExpenses ?? null,
    sumExpenses: total.sumExpenses ?? null,
    sumWithBonusesExpenses: total.sumWithBonusesExpenses ?? null,
  };
}

/* ---------------- auth ---------------- */
async function getToken() {
  const tokenResponse = await axios.post(
    "https://lk.cm.expert/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return tokenResponse.data.access_token;
}

/* ---------------- marketing ----------------
   Важно: по вашему swagger body = { grouping, dealerIds, siteSource, startDate, endDate }
   Никаких stockCardIds не отправляем. Фильтруем нужную карточку уже по ответу (stats[].groupBy).
*/
async function fetchMarketing({ token, dealerId, startDate, endDate, siteSource = null }) {
  const url = "https://lk.cm.expert/api/v1/marketing-statistics/stock-cars";

  const body = {
    grouping: "stockCardId",
    dealerIds: [dealerId],
    startDate,
    endDate,
    siteSource, // null / 'auto.ru' / 'avito.ru' / 'drom.ru'
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return r.data;
}

/* ---------------- health ---------------- */
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------------- main (HTML) ---------------- */
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Проверка авто по VIN</title>
  <style>
    body{font-family:Arial, sans-serif; max-width:980px; margin:40px auto; padding:0 16px; background:#f4f4f4;}
    h1{font-size:44px; margin:0 0 18px;}
    .card{background:#fff; border-radius:18px; padding:26px; box-shadow:0 12px 40px rgba(0,0,0,.10);}
    .input{width:100%; padding:16px; font-size:18px; border:1px solid #ddd; border-radius:10px; outline:none;}
    .row{display:flex; gap:12px; margin-top:14px; flex-wrap:wrap;}
    .btn{padding:14px 20px; font-size:16px; border:none; border-radius:10px; cursor:pointer;}
    .btn-primary{background:#ff5a2c; color:#fff;}
    .btn-secondary{background:#eee; color:#111;}
    .btn:disabled{opacity:.6; cursor:not-allowed;}
    .muted{color:#777; font-size:14px; margin-top:10px;}
    .result{margin-top:18px;}
    .title{font-size:26px; font-weight:800; margin:8px 0 14px;}
    .grid{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
    .item{border:1px solid #eee; border-radius:12px; padding:12px 14px;}
    .label{color:#777; font-size:13px; margin-bottom:6px;}
    .value{font-size:16px; font-weight:700; color:#111;}
    .error{background:#fff2f2; border:1px solid #ffd1d1; color:#b00020; padding:12px 14px; border-radius:12px;}
    .loading{color:#555;}
    .section{margin-top:18px;}
    .section h3{margin:0 0 10px; font-size:18px;}
    @media(max-width:720px){ .grid{grid-template-columns:1fr;} h1{font-size:34px;} }
  </style>
</head>
<body>
  <div class="card">
    <h1>Проверка автомобиля по VIN</h1>

    <input id="vin" class="input" placeholder="Введите VIN (17 символов)" maxlength="17"/>

    <div class="row">
      <button id="btn" class="btn btn-primary" onclick="checkVin()">Проверить VIN</button>
      <button class="btn btn-secondary" onclick="resetAll()">Очистить</button>
    </div>

    <div class="muted">Данные берутся из API. Если VIN неверный — покажем ошибку.</div>

    <div class="result" id="out"></div>
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
function resetAll(){
  document.getElementById('vin').value='';
  document.getElementById('out').innerHTML='';
}

function renderMarketing(marketing){
  if(!marketing || marketing.ok === false){
    const msg = marketing?.message || 'Маркетинг недоступен';
    return '<div class="muted">' + esc(msg) + '</div>';
  }

  const total = marketing.total || {};
  const chats = total.chats || {};
  const bySource = marketing.bySource || {};

  const srcLine = (key, title) => {
    const src = bySource[key] || {};
    const t = src.total || {};
    const c = (t.chats || {});
    const sum = (t.sumWithBonusesExpenses ?? t.sumExpenses);

    return \`
      <div class="item">
        <div class="label">\${esc(title)}</div>
        <div class="value">
          Просмотры: \${t.views ?? '—'} · Чаты: \${c.total ?? '—'} · Расходы: \${sum != null ? formatMoney(sum) : '—'}
        </div>
      </div>
    \`;
  };

  return \`
    <div class="section">
      <h3>Маркетинговая статистика</h3>

      <div class="grid">
        <div class="item">
          <div class="label">Просмотры</div>
          <div class="value">\${total.views ?? '—'}</div>
        </div>

        <div class="item">
          <div class="label">Чаты (всего / пропущено / платные)</div>
          <div class="value">\${chats.total ?? '—'} / \${chats.missed ?? '—'} / \${chats.targeted ?? '—'}</div>
        </div>

        <div class="item">
          <div class="label">Расходы всего (с бонусами)</div>
          <div class="value">\${total.sumWithBonusesExpenses != null ? formatMoney(total.sumWithBonusesExpenses) : (total.sumExpenses != null ? formatMoney(total.sumExpenses) : '—')}</div>
        </div>

        <div class="item">
          <div class="label">Расходы: размещение / звонки / чаты / тариф</div>
          <div class="value">
            \${total.placementExpenses != null ? formatMoney(total.placementExpenses) : '—'} /
            \${total.callsExpenses != null ? formatMoney(total.callsExpenses) : '—'} /
            \${total.chatsExpenses != null ? formatMoney(total.chatsExpenses) : '—'} /
            \${total.tariffsExpenses != null ? formatMoney(total.tariffsExpenses) : '—'}
          </div>
        </div>
      </div>

      <div class="section">
        <h3>Трафик с классифайдов</h3>
        <div class="grid">
          \${srcLine('auto.ru', 'auto.ru')}
          \${srcLine('avito.ru', 'avito.ru')}
          \${srcLine('drom.ru', 'drom.ru')}
        </div>
        <div class="muted">Если по источникам пусто — значит API не вернул данных за период.</div>
      </div>
    </div>
  \`;
}

async function checkVin(){
  const vin = document.getElementById('vin').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');

  if(!vin){ out.innerHTML = '<div class="error">Введите VIN</div>'; return; }
  if(vin.length !== 17){ out.innerHTML = '<div class="error">VIN должен быть 17 символов</div>'; return; }

  btn.disabled = true;
  out.innerHTML = '<div class="loading">Запрос...</div>';

  try{
    const r = await fetch('/check-vin?vin=' + encodeURIComponent(vin));
    const data = await r.json();

    if(!r.ok || data?.ok === false){
      const msg = data?.message || data?.error || 'Ошибка запроса';
      out.innerHTML = '<div class="error">' + esc(msg) + '</div>';
      return;
    }

    out.innerHTML = \`
      <div class="title">\${esc(data.brand)} \${esc(data.model)} \${esc(data.year)}</div>

      <div class="grid">
        <div class="item">
          <div class="label">Комплектация</div>
          <div class="value">\${esc(data.equipmentName || '—')}</div>
        </div>

        <div class="item">
          <div class="label">Модификация</div>
          <div class="value">\${esc(data.modificationName || '—')}</div>
        </div>

        <div class="item">
          <div class="label">Пробег</div>
          <div class="value">\${esc(formatMileage(data.mileage))}</div>
        </div>

        <div class="item">
          <div class="label">Цвет</div>
          <div class="value">\${esc(data.color || '—')}</div>
        </div>
      </div>

      \${renderMarketing(data.marketing)}
    \`;
  }catch(e){
    out.innerHTML = '<div class="error">Ошибка: ' + esc(e.message) + '</div>';
  }finally{
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

/* ---------------- API: VIN -> нужные поля + маркетинг ---------------- */
app.get("/check-vin", async (req, res) => {
  const vin = String(req.query.vin || "").trim();
  if (!vin) return res.status(400).json({ ok: false, error: "VIN is required" });

  try {
    const token = await getToken();

    // 1) авто по VIN
    const carResponse = await axios.get(
      "https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car",
      { params: { vin }, headers: { Authorization: `Bearer ${token}` } }
    );

    const c = carResponse.data || {};

    // 2) маркетинг (последние 30 дней)
    const endDate = toISODate(new Date());
    const startDate = toISODate(addDays(new Date(), -30));

    let marketing = null;

    if (c.dealerId && c.id) {
      try {
        // общий маркетинг за период (по всем источникам)
        const all = await fetchMarketing({
          token,
          dealerId: c.dealerId,
          startDate,
          endDate,
          siteSource: null,
        });

        // берем данные именно по этой карточке из stats
        const allForCar = normalizeMarketingTotal(pickStatByStockCardId(all, c.id));

        // по источникам (классифайды)
        const bySource = {};
        for (const s of ["auto.ru", "avito.ru", "drom.ru"]) {
          const one = await fetchMarketing({
            token,
            dealerId: c.dealerId,
            startDate,
            endDate,
            siteSource: s,
          });

          bySource[s] = {
            total: normalizeMarketingTotal(pickStatByStockCardId(one, c.id)),
            period: { startDate, endDate },
          };
        }

        marketing = {
          ok: true,
          total: allForCar, // уже по этой карточке
          bySource, // уже по этой карточке
          period: { startDate, endDate },
        };

        // если по карточке вообще нет данных — покажем понятное сообщение
        if (!marketing.total) {
          marketing = {
            ok: false,
            message: "Маркетинговых данных по этой карточке за период нет",
            period: { startDate, endDate },
          };
        }
      } catch (e) {
        marketing = {
  ok: false,
  message: "Маркетинг не удалось получить",
  status: e?.response?.status || null,
  details: e?.response?.data || e?.message || String(e),
        };
      }
    } else {
      marketing = {
        ok: false,
        message: "Нет dealerId/id карточки — маркетинг не запросить",
      };
    }

    return res.json({
      ok: true,
      brand: c.brand,
      model: c.model,
      year: c.year,
      equipmentName: c.equipmentName,
      modificationName: c.modificationName,
      mileage: c.mileage,
      color: c.color,
      marketing,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    return res.status(status).json({
      ok: false,
      error: "API request failed",
      status,
      message: data?.message || data?.error || error.message,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
