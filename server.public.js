const express = require('express');
const axios = require('axios');
const { Parser } = require('json2csv');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.HYPIXEL_API_KEY;

let cachedData = {};
let apiCallCount = 0;
let cooldownUntil = null;

app.use(express.json());
app.use(express.static('public'));

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateScore(level, weeklyExp) {
  const idealLevel = 260;
  const idealGEXP = 100000;
  const normLevel = Math.min(level / idealLevel, 1);
  const normGEXP = Math.min(weeklyExp / idealGEXP, 1);
  return (2 - (normLevel + normGEXP)) * 100;
}

async function getUsername(uuid) {
  try {
    const res = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
    return res.data.name || uuid;
  } catch {
    return uuid;
  }
}

async function checkCooldown() {
  if (apiCallCount >= 300) {
    cooldownUntil = Date.now() + 5.05 * 60 * 1000;
    apiCallCount = 0;
  }
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return true;
  }
  cooldownUntil = null;
  return false;
}

app.get('/api/status', (req, res) => {
  const remaining = cooldownUntil ? Math.max(0, cooldownUntil - Date.now()) : 0;
  res.json({ cooldown: remaining });
});

app.get('/api/scan', async (req, res) => {
  const guild = req.query.guild;
  if (!guild) return res.status(400).json({ error: "Missing guild name" });

  if (await checkCooldown()) {
    return res.status(429).json({ error: "API cooldown active", cooldown: cooldownUntil - Date.now() });
  }

  try {
    const guildRes = await axios.get("https://api.hypixel.net/guild", {
      params: { key: API_KEY, name: guild }
    });
    apiCallCount++;

    const members = (guildRes.data.guild?.members || []).filter(m => m.joined < Date.now() - 7 * 86400000);
    const results = [];

    for (const member of members) {
      const uuid = member.uuid;
      const weeklyExp = Object.values(member.expHistory || {}).reduce((a, b) => a + b, 0);
      let level = 0;
      try {
        const res = await axios.get("https://api.hypixel.net/v2/skyblock/profiles", {
          params: { key: API_KEY, uuid }
        });
        apiCallCount++;
        let maxLevel = 0;
        for (const p of res.data.profiles || []) {
          const exp = p?.members?.[uuid]?.leveling?.experience || 0;
          maxLevel = Math.max(maxLevel, exp / 100);
        }
        level = maxLevel;
      } catch {}

      const username = await getUsername(uuid);
      const score = calculateScore(level, weeklyExp);

      results.push({
        username,
        level: parseFloat(level.toFixed(2)),
        weeklyExp,
        score: parseFloat(score.toFixed(2))
      });

      if (await checkCooldown()) break;
      await delay(250);
    }

    results.sort((a, b) => b.score - a.score);
    cachedData[guild.toLowerCase()] = results;
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export', (req, res) => {
  const guild = req.query.guild;
  const data = cachedData[guild?.toLowerCase()];
  if (!data) return res.status(400).json({ error: "No cached data found" });

  const parser = new Parser({ fields: ['username', 'level', 'weeklyExp', 'score'] });
  const csv = parser.parse(data);
  res.setHeader('Content-Disposition', 'attachment; filename=GuildKickQueue.csv');
  res.set('Content-Type', 'text/csv');
  res.send(csv);
});

app.post('/api/webhook', async (req, res) => {
  const { guild, webhook } = req.body;
  const data = cachedData[guild?.toLowerCase()];
  if (!data || !webhook) return res.status(400).json({ error: "Missing data or webhook" });

  const fields = data.slice(0, 25).map((p, i) => ({
    name: `#${i + 1} ${p.username}`,
    value: `Level: ${p.level} | EXP: ${p.weeklyExp} | Score: ${p.score}`,
    inline: false
  }));

  const embed = {
    title: `Kick Queue: ${guild}`,
    description: `Sorted by worst ratio of sb xp to guild xp\n[GitHub](https://github.com/CuteDoggo420/kick-queue) | [Website](https://kick-queue.totemmc.online/)`,
    color: 0xff0000,
    fields,
    timestamp: new Date().toISOString()
  };

  try {
    await axios.post(webhook, { embeds: [embed] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Webhook failed" });
  }
});

app.listen(PORT, () => console.log("Kick queue server began on " + PORT));
