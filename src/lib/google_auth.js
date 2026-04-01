'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger');

const TOKEN_PATH = path.join(__dirname, '../../tokens/google_token.json');
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TOKEN_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6日（7日期限の前日に警告）

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

  // refresh_token の経過日数チェック（7日で失効する可能性）
  if (tokenJson.refresh_token_created_at) {
    const age = Date.now() - tokenJson.refresh_token_created_at;
    if (age > REFRESH_TOKEN_MAX_AGE_MS) {
      logger.warn('google_auth', `refresh_tokenが${Math.floor(age/86400000)}日経過。まもなくinvalid_grantが発生する可能性があります。node tools/setup.js を再実行してください`);
    }
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
      // リフレッシュ済みトークンを保存（refresh_token_created_at を引き継ぐ）
      const merged = { ...tokenJson, ...credentials };
      if (fs.existsSync(path.dirname(TOKEN_PATH))) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
        logger.info('google_auth', 'リフレッシュ済みトークンを保存しました');
      }
    } catch (e) {
      const detail = e?.response?.data?.error || e.message || String(e);
      logger.error('google_auth', 'トークンリフレッシュ失敗', { error: detail });
      const isInvalidGrant = detail === 'invalid_grant' || String(e).includes('invalid_grant');
      if (isInvalidGrant) {
        throw new Error(`INVALID_GRANT: refresh_tokenが失効しました。node tools/setup.js を再実行し、GitHub SecretsとRenderのRENDER_GOOGLE_TOKEN_JSONを両方更新してください`);
      }
      throw new Error(`Googleトークンの更新に失敗しました (${detail})。node tools/setup.js を再実行し、GitHub SecretsとRenderのRENDER_GOOGLE_TOKEN_JSONを両方更新してください`);
    }
  }

  return oauth2;
}

module.exports = { getAuthClient };
