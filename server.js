const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// 1) Проверка что сервер работает
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// 2) Основной метод: поиск авто по VIN
app.get("/check-vin", async (req, res) => {
  const vin = (req.query.vin || "").trim();

  if (!vin) return res.status(400).json({ error: "VIN is required" });

  try {
    // Получаем токен
    const tokenResponse = await axios.post(
      "https://lk.cm.expert/oauth/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const token = tokenResponse.data.access_token;

    // Запрос авто по VIN (по документации: dealers/dms/cars)
    const carResponse = await axios.get(
      `https://lk.cm.expert/api/v1/dealers/dms/cars`,
      {
        params: { vin },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    return res.json(carResponse.data);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    return res.status(500).json({
      error: err.message,
      upstream_status: status,
      upstream_response: data,
    });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
