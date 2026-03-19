'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger');

const TOKEN_PATH = path.join(__dirname, '../../tokens/google_token.json');
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

function loadTokenJson() {
  if (process.env.RENDER_GOOGLE_TOKEN_JSON) {
    return JSON.parse(process.env.RENDER_GOOGLE_TOKEN_JSON);
  }
  if (fs.existsSync(TOKEN_PATH)) {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  }
  throw new Error('Googleトークンが見つかりません。node tools/setup.js を実行して認証してください');
}

async function getAuthClient() {
  let tokenJson;
  try {
    tokenJson = loadTokenJson();
  } catch (e) {
    throw new Error(`Google認証エラー: ${e.message}`);
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
  );
  oauth2.setCredentials(tokenJson);

  // Auto-refresh if expiry_date is set and within margin
  const expiry = tokenJson.expiry_date;
  if (expiry && Date.now() > expiry - REFRESH_MARGIN_MS) {
    try {
      logger.info('google_auth', 'トークンを自動リフレッシュ中...');
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      // Save refreshed token locally if possible
      if (!process.env.RENDER_GOOGLE_TOKEN_JSON && fs.existsSync(path.dirname(TOKEN_PATH))) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...tokenJson, ...credentials }, null, 2));
        logger.info('google_auth', 'リフレッシュ済みトークンを保存しました');
      } else {
        logger.warn('google_auth', 'Render環境: リフレッシュ済みトークンは環境変数を手動更新してください');
      }
    } catch (e) {
      logger.error('google_auth', 'トークンリフレッシュ失敗', { error: e.message });
      throw new Error('Googleトークンの更新に失敗しました。node tools/setup.js を再実行してください');
    }
  }

  return oauth2;
}

module.exports = { getAuthClient };
