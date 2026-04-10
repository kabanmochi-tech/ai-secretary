# AI秘書 LINE Bot

LINEで話しかけるだけで、Google Calendar・Gmail・TODOを自然言語で操作できるAI秘書です。  
Claude（Anthropic）が意図を解釈し、毎朝8時・夜20時に自動でブリーフィングを送信します。

---

## できること

| 送るメッセージ例 | 動作 |
|---|---|
| 「明日の予定教えて」 | Googleカレンダーを照会して一覧返信 |
| 「月曜14時に田中さんとMTG入れて」 | 重複確認→確認→カレンダー登録 |
| 「未読メール見せて」 | Gmail未読を最大5件表示 |
| 「①に了承と返信して」 | 下書き生成→プレビュー→確認→送信 |
| 「TODOに提案書作成を追加して、期限金曜」 | TODO登録→完了通知 |
| 「今日のTODO見せて」 | 未完了タスク一覧表示 |
| 「清算書のFREEに入力をtodoに入れて」 | 自然な語順でのTODO追加 |
| 毎朝8時・夜20時（自動） | 予定・未読メール・TODOをプッシュ通知 |

---

## アーキテクチャ

```
LINE アプリ
    ↓ メッセージ送信
LINE Messaging API (Webhook)
    ↓
Render.com (Express サーバー)
    ├── dispatcher.js  ← Claude APIで意図解釈・ルーティング
    ├── calendar.js    ← Google Calendar API
    ├── gmail.js       ← Gmail API
    └── todo.js        ← TODOメモリ管理

GitHub Actions (cron)
    └── briefing.js    ← 朝8時・夜20時の自動ブリーフィング
```

---

## インフラ構成（完全無料）

| 用途 | サービス | 料金 |
|---|---|---|
| Webhookサーバー | [Render.com](https://render.com) 無料プラン | 無料 |
| 朝夜の自動通知 | GitHub Actions | 月2,000分まで無料 |
| スリープ防止 | [UptimeRobot](https://uptimerobot.com) 無料プラン | 無料 |

---

## セットアップ手順

### 必要なアカウント

- [Google Cloud Console](https://console.cloud.google.com) （Google Calendar / Gmail API）
- [LINE Developers](https://developers.line.biz) （Messaging API）
- [Anthropic Console](https://console.anthropic.com) （Claude API）
- [Render.com](https://render.com) （サーバーホスティング）
- [GitHub](https://github.com) （コード管理 + Actions）

---

### Step 1 — リポジトリをfork・clone

```bash
git clone https://github.com/kabanmochi-tech/ai-secretary.git
cd ai-secretary
npm install
cp .env.example .env
```

---

### Step 2 — Google Cloud 設定（約15分）

1. [Google Cloud Console](https://console.cloud.google.com) でプロジェクト作成
2. 「APIとサービス」→「ライブラリ」で以下を有効化：
   - **Google Calendar API**
   - **Gmail API**
3. 「認証情報」→「OAuthクライアントID作成」
   - 種類: **ウェブアプリケーション**
   - 承認済みリダイレクトURI: `http://localhost:3000/oauth/callback`
4. **OAuth同意画面** → 公開ステータスを **「本番」** に設定
   > ⚠️ テストモードのままだとrefresh_tokenが7日で失効します
5. クライアントID・クライアントシークレットを `.env` に記入

---

### Step 3 — LINE設定（約5分）

1. [LINE Developers](https://developers.line.biz) でチャネル作成（Messaging API）
2. 以下を `.env` に記入：
   - `LINE_CHANNEL_ACCESS_TOKEN`（チャネルアクセストークン・長期）
   - `LINE_CHANNEL_SECRET`（チャネルシークレット）
   - `LINE_USER_ID`（あなた自身のLINE User ID）
     > User IDの確認: LINE Developers → チャネル → Messaging API設定 → Your user ID

---

### Step 4 — Anthropic APIキー

1. [Anthropic Console](https://console.anthropic.com) でAPIキーを取得
2. `ANTHROPIC_API_KEY` に記入

---

### Step 5 — Google OAuth認証（ローカルで1回だけ実行）

```bash
node tools/setup.js
```

ブラウザが開くのでGoogleアカウントでログイン → `tokens/google_token.json` が生成されます。

---

### Step 6 — Render.com デプロイ

1. このリポジトリをGitHubにpush（forkしたリポジトリでもOK）
2. [Render.com](https://render.com) でアカウント作成 → 「New Web Service」→ リポジトリを選択
3. 設定：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. 「Environment Variables」に `.env` の内容をすべて登録
5. `RENDER_GOOGLE_TOKEN_JSON` に `tokens/google_token.json` の中身（JSON文字列）を貼り付け
6. デプロイ完了後のURL例: `https://ai-secretary-xxxx.onrender.com`
7. LINE Developers → Webhook URL を `https://ai-secretary-xxxx.onrender.com/webhook` に設定

---

### Step 7 — UptimeRobot でスリープ防止（約3分）

1. [UptimeRobot](https://uptimerobot.com) でアカウント作成（無料）
2. 「Add New Monitor」で設定：
   - Monitor Type: **HTTP(s)**
   - URL: `https://ai-secretary-xxxx.onrender.com/health`
   - Monitoring Interval: **5 minutes**

---

### Step 8 — GitHub Actions 設定（朝夜の自動通知）

GitHubリポジトリの「Settings → Secrets and variables → Actions」で以下を登録：

| Secret名 | 値 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE チャネルアクセストークン |
| `LINE_CHANNEL_SECRET` | LINE チャネルシークレット |
| `LINE_USER_ID` | あなたのLINE User ID |
| `ANTHROPIC_API_KEY` | Anthropic APIキー |
| `GOOGLE_CLIENT_ID` | Google OAuthクライアントID |
| `GOOGLE_CLIENT_SECRET` | Google OAuthクライアントシークレット |
| `RENDER_GOOGLE_TOKEN_JSON` | `tokens/google_token.json` の中身 |
| `GH_PAT` | GitHub Personal Access Token（Secrets書き込み権限）|

> `GH_PAT` は「Settings → Developer settings → Personal access tokens → Fine-grained tokens」で作成。スコープに `secrets: write` を付与。

---

### Step 9 — 動作確認

```bash
# LINEにテストメッセージ送信
node tools/test_line.js

# ブリーフィング手動実行
node src/briefing.js morning
```

LINEで「明日の予定教えて」と送ってみましょう。

---

## 環境変数一覧

`.env.example` を参照してください。

```
LINE_CHANNEL_ACCESS_TOKEN=   # LINE Messaging APIトークン
LINE_CHANNEL_SECRET=         # LINE チャネルシークレット
LINE_USER_ID=                # あなたのLINE User ID
ANTHROPIC_API_KEY=           # Claude APIキー
GOOGLE_CLIENT_ID=            # Google OAuth クライアントID
GOOGLE_CLIENT_SECRET=        # Google OAuth シークレット
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
RENDER_GOOGLE_TOKEN_JSON=    # google_token.json の中身（Render用）
```

---

## ファイル構成

```
ai-secretary/
├── src/
│   ├── server.js          — Expressサーバー (GET /health, POST /webhook)
│   ├── dispatcher.js      — メッセージルーティング（直接パス + AI解析）
│   ├── ai.js              — Claude APIによる意図解析
│   ├── calendar.js        — Google Calendar APIラッパー
│   ├── gmail.js           — Gmail APIラッパー
│   ├── todo.js            — TODOメモリ管理
│   ├── line.js            — LINE Messaging APIラッパー
│   ├── briefing.js        — 朝夜ブリーフィング生成
│   └── lib/
│       ├── google_auth.js — OAuth2トークン管理・自動リフレッシュ
│       └── logger.js      — ロガー
├── .github/workflows/
│   └── morning-briefing.yml  — 朝8時・夜20時の自動実行
├── tools/
│   ├── setup.js           — Google OAuth初期設定（ローカルで1回実行）
│   └── test_line.js       — LINE送信テスト
├── tokens/                — Googleトークン保存先（.gitignoreで除外）
├── .env.example           — 環境変数テンプレート
└── README.md
```

---

## トラブルシューティング

### Google認証エラー（INVALID_GRANT）が発生する

OAuthアプリが「テストモード」のままだとrefresh_tokenが**7日で失効**します。

**恒久対応**: Google Cloud Console → 「OAuth同意画面」→ 公開ステータスを **「本番環境」** に変更

**応急処置**:
```bash
node tools/setup.js   # 再認証してトークンを更新
```
その後、GitHub SecretsとRenderの `RENDER_GOOGLE_TOKEN_JSON` を両方更新してください。

### Renderでスリープして応答が遅い

UptimeRobotの設定（Step 7）を確認してください。`/health` エンドポイントを5分おきにpingすることでスリープを防止できます。

### 朝の通知が来ない

GitHub Actions の「Actions」タブで実行ログを確認してください。`RENDER_GOOGLE_TOKEN_JSON` が最新のトークンになっているか確認してください。

---

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照してください。

---

## 使用技術

- [Claude API (Anthropic)](https://www.anthropic.com) — 自然言語意図解析
- [Google Calendar API](https://developers.google.com/calendar) — カレンダー操作
- [Gmail API](https://developers.google.com/gmail) — メール操作
- [LINE Messaging API](https://developers.line.biz/ja/services/messaging-api/) — LINEチャット連携
- [Express.js](https://expressjs.com) — Webhookサーバー
- [Render.com](https://render.com) — ホスティング
