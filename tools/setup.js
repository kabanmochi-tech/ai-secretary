require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
];

const TOKEN_PATH = path.join(__dirname, '../tokens/google_token.json');
const ENV_PATH = path.join(__dirname, '../.env');

async function main() {
  // .env の存在確認
  if (!fs.existsSync(ENV_PATH)) {
    console.error('.env ファイルが見つかりません。');
    console.error('.env.example をコピーして各値を記入してください:');
    console.error('  cp .env.example .env');
    process.exit(1);
  }

  // 必要な環境変数の確認
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('以下の環境変数が .env に設定されていません:');
    missing.forEach(k => console.error(`  ${k}`));
    process.exit(1);
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback';
  const port = new URL(redirectUri).port || 3000;

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n以下のURLをブラウザで開いてGoogleアカウントを認証してください:\n');
  console.log(authUrl);
  console.log('\nブラウザで認証後、自動的にトークンが保存されます...\n');

  // 一時サーバーを起動してコールバックを受け取る
  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, `http://localhost:${port}`);
        if (urlObj.pathname !== '/oauth/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = urlObj.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('code がありません');
          return;
        }

        const { tokens } = await oauth2.getToken(code);

        // tokensディレクトリ作成
        const tokensDir = path.join(__dirname, '../tokens');
        if (!fs.existsSync(tokensDir)) fs.mkdirSync(tokensDir);

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>✅ Google認証完了。このブラウザタブを閉じてください。</h2>');

        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end('エラー: ' + err.message);
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`ローカルサーバー起動中 (port: ${port}) — ブラウザで認証してください`);
    });

    server.on('error', reject);
  });

  console.log('\n✅ Google認証が完了しました！');
  console.log('Render.comの環境変数 RENDER_GOOGLE_TOKEN_JSON に');
  console.log('以下をそのままコピーして貼り付けてください:\n');

  const tokenContent = fs.readFileSync(TOKEN_PATH, 'utf8');
  console.log(tokenContent);

  console.log('\nその後: node tools/test_line.js でLINE接続を確認してください。');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
