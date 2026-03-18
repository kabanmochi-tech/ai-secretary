require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

const FALLBACK = {
  action: 'unknown',
  params: {},
  reply: 'すみません、もう一度おっしゃっていただけますか？',
  needs_confirm: false,
};

async function parseIntent(userMessage, context = {}) {
  const { recentMessages = [], pendingAction = null } = context;
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const systemPrompt = `あなたはAI秘書システムのディスパッチャーです。
ユーザーのメッセージを解析し、必ず以下のJSON形式のみで応答してください。
マークダウンのコードブロックや余計な文字は絶対に出力しないこと。

{
  "action": "calendar_list"|"calendar_add"|"calendar_delete"|
            "gmail_list"|"gmail_draft"|"gmail_send"|"gmail_read"|
            "todo_add"|"todo_list"|"todo_done"|"todo_delete"|
            "briefing"|"unknown",
  "params": {},
  "reply": "ユーザーへの返答",
  "needs_confirm": true|false
}

action別のparams:
- calendar_list: { date: "YYYY-MM-DD", range_days: 1 }
- calendar_add: { title: "", start: "YYYY-MM-DDTHH:mm:ss+09:00", end: "YYYY-MM-DDTHH:mm:ss+09:00", description: "" }
- calendar_delete: { event_id: "" }
- gmail_list: { max: 5, query: "" }
- gmail_draft: { to: "", subject: "", body: "", reply_to_id: "" }
- gmail_send: { draft_id: "" }
- gmail_read: { message_id: "" }
- todo_add: { title: "", due_date: "YYYY-MM-DD or null", priority: "high|normal|low" }
- todo_list: { filter: "all|today|pending" }
- todo_done: { id: 0 }
- todo_delete: { id: 0 }
- briefing: {}
- unknown: {}

今日の日時(JST): ${now}`;

  const messages = [];
  for (const m of recentMessages) {
    messages.push(m);
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages,
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    console.error('[ai.parseIntent] error:', err.message);
    return FALLBACK;
  }
}

async function generateReply(systemPrompt, userMessage) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error('[ai.generateReply] error:', err.message);
    throw err;
  }
}

module.exports = { parseIntent, generateReply };
