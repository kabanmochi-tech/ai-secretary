require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

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
  "action": "calendar_list"|"calendar_add"|"calendar_add_multi"|"calendar_update"|"calendar_delete"|"calendar_add_recurring"|
            "gmail_list"|"gmail_draft"|"gmail_send"|"gmail_read"|
            "todo_add"|"todo_list"|"todo_done"|"todo_done_by_num"|"todo_done_by_keyword"|"todo_delete"|"todo_delete_by_title"|"todo_note"|"todo_setup_recurring"|
            "briefing"|"unknown",
  "params": {},
  "reply": "ユーザーへの返答",
  "needs_confirm": true|false
}

action別のparams:
- calendar_list: { date: "YYYY-MM-DD", range_days: 1 }
- calendar_add: { title: "", start: "YYYY-MM-DDTHH:mm:ss+09:00", end: "YYYY-MM-DDTHH:mm:ss+09:00", description: "" }
- calendar_delete: { keyword: "予定タイトルの一部", date: "YYYY-MM-DD（わかる場合のみ、省略可）" }
- calendar_update: { keyword: "予定タイトルの一部", date: "YYYY-MM-DD（わかる場合のみ）", new_title: "（変更なければ省略）", new_start: "YYYY-MM-DDTHH:mm:ss+09:00（変更なければ省略）", new_end: "YYYY-MM-DDTHH:mm:ss+09:00（変更なければ省略）" }
- calendar_add_multi: { events: [{ title: "", start: "YYYY-MM-DDTHH:mm:ss+09:00", end: "YYYY-MM-DDTHH:mm:ss+09:00", description: "" }] }
- calendar_add_recurring: { title: "", rrule: "FREQ=MONTHLY;BYDAY=2FR", start_date: "YYYY-MM-DD", start_time: "09:00", end_time: "09:30", description: "" }
- gmail_list: { max: 5, query: "" }
- gmail_draft: { to: "", subject: "", body: "", reply_to_id: "" }
- gmail_send: { draft_id: "" }
- gmail_read: { message_id: "" }
- todo_add: { title: "", due_date: "YYYY-MM-DD or null", priority: "high|normal|low" }
- todo_list: { filter: "all|today|pending|completed" }
- todo_done: { id: "" }
- todo_done_by_num: { num: 1 }
- todo_done_by_keyword: { keyword: "タスクタイトルの一部" }
- todo_delete: { id: "" }
- todo_delete_by_title: { titles: ["削除するタイトルの一部（部分一致でOK）"] }
- todo_note: { keyword: "タスクタイトルの一部", note: "追加するメモ内容" }
- todo_setup_recurring: {
    todos: [{ title: "", priority: "high|normal|low" }],
    reminder_title: "カレンダーリマインダーのタイトル",
    reminder_rrule: "FREQ=MONTHLY;BYDAY=2FR",
    reminder_description: "リマインド内容の説明"
  }
- briefing: {}
- unknown: {}

calendar_listのrange_days:
- 「今日」「明日」→ range_days: 1
- 「今週」→ range_days: 7、date: 今週月曜日
- 「明日から3日」→ range_days: 3
- 「今月」→ range_days: 30

RRULE早見表:
- 毎月第2金曜 → FREQ=MONTHLY;BYDAY=2FR
- 毎月第3金曜 → FREQ=MONTHLY;BYDAY=3FR
- 毎月末日 → FREQ=MONTHLY;BYMONTHDAY=-1
- 毎週月曜 → FREQ=WEEKLY;BYDAY=MO
- 「第N曜日」→ BYDAY=NFR（F=金曜, MO=月, TU=火, WE=水, TH=木, FR=金, SA=土, SU=日）

判断の例（必ずこれに従うこと）:
- 「予定」「スケジュール」「カレンダー」→ calendar_list or calendar_add
- 「リマインダー」「リマインドをセット」→ calendar_add（予定として登録する）
- 「朝イチ」→ 09:00 として扱う
- 「メール」「未読」「受信」「inbox」→ gmail_list
- 「TODO」「タスク」「やること」→ todo_list or todo_add
- 「未読メールみせて」→ gmail_list（絶対にcalendar系にしない）
- 「今日の予定」→ calendar_list（絶対にgmail系にしない）
- 「予定を変更/移動/ずらして」→ calendar_update（keywordに予定名、new_start/new_endに新しい時刻）
- 「〇〇を削除/消して」（カレンダー） → calendar_delete（keywordに予定名）
- 「〇〇日と△△日に予定を追加」「〇〇と△△の2件を追加」など複数の異なる日時への追加 → calendar_add_multi（eventsに全件を入れる）
- 「毎月」「繰り返し」+ TODO複数項目 + リマインド → todo_setup_recurring
- 「①②③」形式で複数タスク + 登録 → todo_setup_recurring（todosに全項目を入れる）
- 「登録して」「とうろく」「追加して」→ todo_add または todo_setup_recurring
- 「第2金曜」「第二金曜」→ reminder_rrule: "FREQ=MONTHLY;BYDAY=2FR"
- 「第3金曜」「第三金曜」→ FREQ=MONTHLY;BYDAY=3FR
- TODO一覧表示は「TODO見せて」「TODO一覧」「TODOは？」など明示的に確認を求めた場合のみ
- 「済みタスク/完了タスクを見せて」→ todo_list, filter: "completed"
- 「〇〇のTODO消して」「下記のtodo消して」→ todo_delete_by_title（titlesにタイトルの一部を入れる）
  ※ タイトルのIDは不明なので必ずtodo_delete_by_titleを使うこと。todo_deleteは使わない
- 「①のタスクを完了」→ todo_done_by_num, num: 1
- 「提案書のタスクを完了にして」「○○を終わらせた」など、タイトル名でTODOを完了したい場合 → todo_done_by_keyword, keyword: "タスクタイトルの一部"
- todo_done（id指定）は使わない。IDはユーザーには不明なため、代わりに todo_done_by_keyword を使うこと
- 「2番と3番を消して」→ titlesに具体的なタイトル文字列（番号ではなく内容）を入れる
- 「タスクにメモを追加」「ノートを追加」「覚書を追加」→ todo_note（keywordにタスク名の一部、noteにメモ内容）

今日の日時(JST): ${now}`;

  const messages = [];
  for (const m of recentMessages) {
    messages.push(m);
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    let text = response.content[0].text.trim();
    // マークダウンコードブロックを除去
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // 前後に説明文が混入した場合でもJSONオブジェクトを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0].trim();
    console.log('[ai.parseIntent] raw:', text.slice(0, 200));
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
