require('dotenv').config();
const cron = require('node-cron');
const { GoogleCalendarClient } = require('./calendar');
const { GmailClient } = require('./gmail');
const todo = require('./todo');
const { LineClient } = require('./line');

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function todayLabel() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`;
}

function formatTime(isoStr) {
  if (!isoStr || isoStr.length <= 10) return '';
  const d = new Date(isoStr);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

async function generate() {
  const calendarClient = new GoogleCalendarClient();
  const gmailClient = new GmailClient();

  // メッセージ1: 挨拶
  const msg1 = `おはようございます☀️\n${todayLabel()}のブリーフィングです。`;

  // メッセージ2: 予定
  let todayEvents = [];
  let tomorrowEvents = [];
  try {
    todayEvents = await calendarClient.getTodayEvents();
    tomorrowEvents = await calendarClient.getTomorrowEvents();
  } catch (e) {
    console.error('[briefing] calendar error:', e.message);
  }

  const todayLines = [`📅 本日の予定（${todayEvents.length}件）`, '━━━━━━━━━━'];
  if (todayEvents.length === 0) {
    todayLines.push('本日は予定が入っていません');
  } else {
    for (const e of todayEvents) {
      const s = formatTime(e.start);
      const en = formatTime(e.end);
      todayLines.push(s && en ? `${s}〜${en} ${e.title}` : e.title);
    }
  }

  if (tomorrowEvents.length > 0) {
    todayLines.push('');
    todayLines.push('📅 明日の予定');
    for (const e of tomorrowEvents) {
      const s = formatTime(e.start);
      todayLines.push(s ? `${s}〜 ${e.title}` : e.title);
    }
  }
  const msg2 = todayLines.join('\n');

  // メッセージ3: メール + TODO
  let unreadCount = 0;
  try {
    unreadCount = await gmailClient.getUnreadCount();
  } catch (e) {
    console.error('[briefing] gmail error:', e.message);
  }

  const todayTodos = todo.getTodayDue();
  const lines3 = [
    `📧 未読メール: ${unreadCount}件`,
    `📋 今日期限のTODO: ${todayTodos.length}件`,
    '━━━━━━━━━━',
  ];

  if (todayTodos.length === 0 && unreadCount === 0) {
    lines3.push('本日は特に対応事項はありません');
  } else {
    for (const t of todayTodos) {
      const icon = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      lines3.push(`${icon} ${t.title}`);
    }
  }
  const msg3 = lines3.join('\n');

  return [msg1, msg2, msg3];
}

async function run() {
  const lineClient = new LineClient();
  const messages = await generate();
  await lineClient.pushMessages(messages);
  console.log('[briefing] 送信完了');
}

function startCron() {
  const lineClient = new LineClient();
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[briefing] cron実行');
      const messages = await generate();
      await lineClient.pushMessages(messages);
    } catch (e) {
      console.error('[briefing] cron error:', e.message);
    }
  }, { timezone: 'Asia/Tokyo' });
  console.log('[briefing] cronスケジュール登録済み（毎朝8時 JST）');
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { generate, startCron };
