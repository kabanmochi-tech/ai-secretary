require('dotenv').config();
const cron = require('node-cron');
const { GoogleCalendarClient } = require('./calendar');
const { GmailClient } = require('./gmail');
const todo = require('./todo');
const { LineClient, formatCalendarEvents } = require('./line');

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function dateLabel(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(isoStr) {
  if (!isoStr || isoStr.length <= 10) return '';
  return new Date(isoStr).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
}

// 予定リストを1メッセージに整形
function buildScheduleMsg(label, events) {
  const lines = [`📅 ${label}（${events.length}件）`, '━━━━━━━━━━'];
  if (events.length === 0) {
    lines.push('予定はありません');
  } else {
    for (const e of events) {
      const s = formatTime(e.start);
      const en = formatTime(e.end);
      lines.push(s && en ? `${s}〜${en} ${e.title}` : e.title);
    }
  }
  return lines.join('\n');
}

// 1週間予定（日付ごとグループ）
function buildWeekMsg(events, fromLabel) {
  const lines = [`📅 ${fromLabel}からの1週間（${events.length}件）`, '━━━━━━━━━━'];
  if (events.length === 0) {
    lines.push('予定はありません');
    return lines.join('\n');
  }
  const groups = {};
  for (const e of events) {
    const key = (e.start || '').slice(0, 10);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  for (const key of Object.keys(groups).sort()) {
    const d = new Date(key + 'T00:00:00+09:00');
    lines.push(dateLabel(d));
    for (const e of groups[key]) {
      const s = formatTime(e.start);
      const en = formatTime(e.end);
      lines.push(`  ${s && en ? `${s}〜${en} ` : ''}${e.title}`);
    }
  }
  return lines.join('\n');
}

// 未読メールメッセージ
async function buildMailMsg(gmailClient) {
  try {
    const emails = await gmailClient.listUnread(5, 'in:inbox is:unread');
    if (!emails.length) return '📧 未読メール（受信ボックス）\n━━━━━━━━━━\nなし';
    const nums = ['①','②','③','④','⑤'];
    const lines = [`📧 未読メール（${emails.length}件）`, '━━━━━━━━━━'];
    emails.forEach((e, i) => {
      const sender = e.from.replace(/<.*>/, '').trim().replace(/"/g, '') || e.from;
      lines.push(`${nums[i] || `${i+1}.`} ${sender}「${e.subject}」`);
    });
    return lines.join('\n');
  } catch {
    return '📧 未読メール: 取得できませんでした';
  }
}

// TODOメッセージ
async function buildTodoMsg() {
  try {
    const items = await todo.list('pending');
    return await todo.formatList(items);
  } catch {
    return '📋 TODO: 取得できませんでした';
  }
}

// ── 朝8時ブリーフィング ──────────────────────
async function generateMorning() {
  const cal = new GoogleCalendarClient();
  const gmail = new GmailClient();
  const now = jstNow();

  const todayStr = toDateStr(now);
  const [todayEvents, weekEvents] = await Promise.allSettled([
    cal.listEvents(todayStr, 1),
    cal.listEvents(todayStr, 7),
  ]).then(r => r.map(x => x.value || []));

  return [
    `おはようございます☀️\n${dateLabel(now)}の朝のブリーフィングです。`,
    buildScheduleMsg(`本日 ${dateLabel(now)}`, todayEvents),
    buildWeekMsg(weekEvents, dateLabel(now)),
    await buildMailMsg(gmail),
    buildTodoMsg(),
  ];
}

// ── 夜20時ブリーフィング ─────────────────────
async function generateEvening() {
  const cal = new GoogleCalendarClient();
  const gmail = new GmailClient();
  const now = jstNow();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const tomorrowStr = toDateStr(tomorrow);
  const weekFromTomorrow = toDateStr(tomorrow);
  const [tomorrowEvents, weekEvents] = await Promise.allSettled([
    cal.listEvents(tomorrowStr, 1),
    cal.listEvents(weekFromTomorrow, 7),
  ]).then(r => r.map(x => x.value || []));

  return [
    `🌙 ${dateLabel(now)} 夜のブリーフィングです。`,
    buildScheduleMsg(`明日 ${dateLabel(tomorrow)}`, tomorrowEvents),
    buildWeekMsg(weekEvents, dateLabel(tomorrow)),
    await buildMailMsg(gmail),
    buildTodoMsg(),
  ];
}

// ── GitHub Actions / 単体実行エントリーポイント ──
async function run() {
  const lineClient = new LineClient();
  const type = process.argv[2] || 'morning';
  const messages = type === 'evening' ? await generateEvening() : await generateMorning();
  await lineClient.pushMessages(messages);
  console.log(`[briefing] ${type} 送信完了`);
}

// ── Renderサーバー用cronスケジューラー ──────────
function startCron() {
  const lineClient = new LineClient();

  // 朝8時
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[briefing] 朝cron実行');
      const messages = await generateMorning();
      await lineClient.pushMessages(messages);
    } catch (e) {
      console.error('[briefing] 朝cron error:', e.message);
    }
  }, { timezone: 'Asia/Tokyo' });

  // 夜20時
  cron.schedule('0 20 * * *', async () => {
    try {
      console.log('[briefing] 夜cron実行');
      const messages = await generateEvening();
      await lineClient.pushMessages(messages);
    } catch (e) {
      console.error('[briefing] 夜cron error:', e.message);
    }
  }, { timezone: 'Asia/Tokyo' });

  console.log('[briefing] cronスケジュール登録済み（朝8時・夜20時 JST）');
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { generateMorning, generateEvening, startCron };
