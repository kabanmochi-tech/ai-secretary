# AI秘書システム
## 概要
LINEで話しかけるとGoogle Calendar・Gmail・TODOを操作するAI秘書。
毎朝8時に自動サマリーをLINEプッシュ通知。

## インフラ（完全無料）
- Render.com: Webhook受信・LINE返信サーバー（無料プラン）
- GitHub Actions: 朝8時の自動通知
- UptimeRobot: /health を5分おきに叩いてRenderスリープを防止

## アーキテクチャ
- src/server.js     : LINE WebhookのExpressサーバー。GET /health がUptimeRobot用
- src/dispatcher.js : Claudeで意図解釈して各機能にルーティング
- src/calendar.js   : Google Calendar APIラッパー
- src/gmail.js      : Gmail APIラッパー
- src/todo.js       : メモリTODO（Render無料プランはFS非永続のためメモリ管理）
- src/line.js       : LINE Messaging APIラッパー
- src/briefing.js   : 朝のサマリー生成（node src/briefing.js で単体実行可能）
- src/ai.js         : Claude APIクライアント

## Googleトークンの読み込み方法
ローカル: tokens/google_token.json から読む
Render上: 環境変数 RENDER_GOOGLE_TOKEN_JSON（JSON文字列）から読む
→ calendar.js と gmail.js の両方でこの切り替えを実装すること

## 秘書のキャラクター
- 口調: 丁寧だが簡潔
- 返信: 日本語。長い場合は箇条書き
- Gmailは下書き保存→確認→送信の順（勝手に送らない）
- 予定削除・メール送信は必ず確認を取る
