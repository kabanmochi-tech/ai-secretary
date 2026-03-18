# AI秘書

LINEで話しかけるとGoogle Calendar・Gmail・TODOを操作するAI秘書システム。

## できること

| 送るメッセージ | 動作 |
|---|---|
| 「明日の予定教えて」 | カレンダーを照会して一覧返信 |
| 「月曜14時に田中さんとMTG入れて」 | 重複確認→確認→登録 |
| 「山田さんのメール返信して。出張は対応可能と伝えて」 | 下書き生成→プレビュー→確認→送信 |
| 「TODOに提案書作成を追加して、期限金曜、高優先度」 | TODO登録→確認返信 |
| 「今日のTODO見せて」 | 一覧表示 |
| 毎朝8時（自動） | 予定＋未読メール件数＋今日期限TODOをプッシュ通知 |

## インフラ構成（完全無料）

| 用途 | サービス | 備考 |
|---|---|---|
| Webhookサーバー | Render.com 無料プラン | HTTPS URL自動付与 |
| 朝の自動通知 | GitHub Actions | 月2000分まで無料 |
| スリープ防止 | UptimeRobot 無料プラン | 5分おきにping |

## セットアップ手順

### Step 1 — Google Cloud設定（約15分）

1. https://console.cloud.google.com でプロジェクト作成
2. 「APIとサービス」→「ライブラリ」で「Google Calendar API」と「Gmail API」を有効化
3. 「認証情報」→「OAuthクライアントID作成」（種類: ウェブアプリ）
4. 承認済みリダイレクトURI: `http://localhost:3000/oauth/callback` を追加
5. クライアントIDとシークレットを `.env` に記入

### Step 2 — LINE設定（約5分）

1. https://developers.line.biz でチャネル作成（Messaging API）
2. チャネルアクセストークン（長期）、チャネルシークレット、USER IDを `.env` に記入

### Step 3 — Anthropic APIキー

1. https://console.anthropic.com でAPIキーを取得して `.env` に記入

### Step 4 — Google OAuth認証（ローカルで実行）

```bash
cp .env.example .env
# .env を編集して各値を記入
npm install
node tools/setup.js
```

### Step 5 — Render.comデプロイ

1. GitHubにリポジトリを作成して `git push`
2. https://render.com でアカウント作成 → 「New Web Service」→ リポジトリを選択
3. Build Command: `npm install` / Start Command: `npm start`
4. Environment Variablesに `.env` の内容をすべて登録
5. `RENDER_GOOGLE_TOKEN_JSON` に `cat tokens/google_token.json` の内容を貼り付け
6. デプロイ完了後のURL（`https://xxxx.onrender.com`）をコピー
7. LINE Developers → Webhook URLに `https://xxxx.onrender.com/webhook` を設定

### Step 6 — UptimeRobotでスリープ防止（約3分）

1. https://uptimerobot.com でアカウント作成（無料）
2. 「Add New Monitor」をクリック
3. 設定:
   - Monitor Type: HTTP(s)
   - Friendly Name: AI秘書
   - URL: `https://xxxx.onrender.com/health`  ← Renderのデプロイ後に確定するURL
   - Monitoring Interval: 5 minutes
4. 「Create Monitor」で保存

→ これでRender.comの無料プランのスリープ（15分無通信でスリープ）を防止できます

### Step 7 — GitHub Actions設定（朝の通知）

Settings → Secrets and variables → Actions → 「New repository secret」で以下を登録:

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `LINE_USER_ID`
- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `RENDER_GOOGLE_TOKEN_JSON`（`cat tokens/google_token.json` の内容）

### Step 8 — 動作確認

```bash
node tools/test_line.js
```

LINEで「明日の予定教えて」と送ってみる。

## ファイル構成

```
ai-secretary/
├── src/
│   ├── server.js      — Expressサーバー（Render.comにデプロイ）
│   ├── dispatcher.js  — 意図解釈・ルーティング
│   ├── calendar.js    — Google Calendar操作
│   ├── gmail.js       — Gmail操作
│   ├── todo.js        — TODOメモリ管理
│   ├── line.js        — LINE送受信
│   ├── briefing.js    — 朝のサマリー生成
│   └── ai.js          — Claude APIクライアント
├── .github/workflows/
│   └── morning-briefing.yml  — 毎朝8時の自動実行
├── tools/
│   ├── setup.js       — Google OAuth初期設定
│   └── test_line.js   — LINE送信テスト
├── tokens/            — Google OAuthトークン（.gitignoreで除外）
├── .env.example       — 環境変数テンプレート
└── README.md
```
