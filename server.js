const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/check-vin", async (req, res) => {
    const vin = req.query.vin;

    if (!vin) {
        return res.json({ error: "VIN is required" });
    }

    try {

        const tokenResponse = await axios.post(
            "https://lk.cm.expert/oauth/token",
            new URLSearchParams({
                grant_type: "client_credentials",
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }
        );

        const token = tokenResponse.data.access_token;

        const carResponse = await axios.get(
            `https://lk.cm.expert/api/v1/car/appraisal/find-last-by-car?vin=${vin}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        res.json(carResponse.data);

    } catch (error) {
        res.json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
