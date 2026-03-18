/**
 * server.js — メインサーバー
 *
 * GET /health をUptimeRobotが5分おきに叩くことで
 * Render.com無料プランのスリープ（15分無通信でスリープ）を防止する。
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { dispatch } = require('./dispatcher');
const { LineClient } = require('./line');
const { startCron } = require('./briefing');

const app = express();
const startTime = Date.now();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

const lineClient = new LineClient();

// LINE Webhookは生のbodyが必要なため先にraw bodyを保存
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// POST /webhook — LINE Webhook受信
// ============================================================
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const body = req.body;

  // 署名検証
  if (!lineClient.verifySignature(body, signature)) {
    console.warn('[webhook] 署名検証失敗');
    return res.status(400).json({ error: 'invalid signature' });
  }

  // 即200を返す（LINE仕様: 処理を待たない）
  res.status(200).send('OK');

  // 非同期で処理
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    for (const event of parsed.events || []) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        dispatch(userId, userMessage, replyToken).catch(err => {
          console.error('[dispatch] error:', err.message);
        });
      }
    }
  } catch (err) {
    console.error('[webhook] parse error:', err.message);
  }
});

// ============================================================
// GET /health — UptimeRobot用ヘルスチェック
// ※ このエンドポイントをUptimeRobotが5分おきに叩くことで、
//   Render無料プランのスリープを防止する仕組みになっている。
// ============================================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    message: 'AI秘書 稼働中',
  });
});

// ============================================================
// GET /oauth/callback — Google OAuthコールバック
// ============================================================
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('code がありません');

  try {
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`
    );
    const { tokens } = await oauth2.getToken(code);
    const tokenPath = path.join(__dirname, '../tokens/google_token.json');
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    console.log('[oauth] トークン保存:', tokenPath);
    res.send('Google認証完了。ブラウザを閉じてください。');
  } catch (err) {
    console.error('[oauth] error:', err.message);
    res.status(500).send('認証に失敗しました: ' + err.message);
  }
});

// ============================================================
// 起動
// ============================================================
app.listen(PORT, () => {
  console.log(`AI秘書 起動 PORT:${PORT} ENV:${ENV}`);
  startCron();
});

module.exports = app;
