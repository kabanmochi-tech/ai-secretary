require('dotenv').config();
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
    // all-dayはdate文字列(10文字)をそのまま使用、timed eventsはJSTに変換してからslice
    const raw = e.start || '';
    const key = raw.length <= 10
      ? raw
      : new Date(raw).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  for (const key of Object.keys(groups).sort()) {
    // 正午JST(03:00 UTC)で曜日計算→UTC環境でも日付ずれが起きない
    const d = new Date(`${key}T12:00:00+09:00`);
    const mm = parseInt(key.slice(5, 7));
    const dd = parseInt(key.slice(8, 10));
    lines.push(`${mm}月${dd}日（${WEEKDAY_JA[d.getDay()]}）`);
    for (const e of groups[key]) {
      const s = formatTime(e.start);
      const en = formatTime(e.end);
      lines.push(`  ${s && en ? `${s}〜${en} ` : ''}${e.title}`);
    }
  }
  return lines.join('\n');
}

// 未読メールメッセージ
const EXCLUDE_REAL_ESTATE =
  '-subject:(物件紹介 OR 新着物件 OR 物件情報 OR 不動産情報 OR 賃貸物件 OR 売買物件 OR マンション情報 OR "物件のご紹介" OR "新着のご案内" OR "おすすめ物件" OR "物件特集" OR テラスハウス OR アパート OR 利回り OR 満室 OR 空室 OR 戸数 OR 収益物件 OR 投資物件)' +
  ' -from:(homes.co.jp OR suumo.jp OR athome.co.jp OR chintai.com OR realestate)';

async function buildMailMsg(gmailClient) {
  try {
    const emails = await gmailClient.listUnread(5, `in:inbox is:unread ${EXCLUDE_REAL_ESTATE}`);
    if (!emails.length) return '📧 未読メール（受信ボックス）\n━━━━━━━━━━\nなし';
    const nums = ['①','②','③','④','⑤'];
    const lines = [`📧 未読メール（${emails.length}件）`, '━━━━━━━━━━'];
    emails.forEach((e, i) => {
      const sender = e.from.replace(/<.*>/, '').trim().replace(/"/g, '') || e.from;
      lines.push(`${nums[i] || `${i+1}.`} ${sender}「${e.subject}」`);
    });
    return lines.join('\n');
  } catch (e) {
    console.error('[briefing] メール取得エラー:', e.message);
    return `📧 未読メール: 取得失敗\n（${e.message}）`;
  }
}

// TODOメッセージ
async function buildTodoMsg() {
  try {
    const items = await todo.list('pending');
    return await todo.formatList(items);
  } catch (e) {
    console.error('[briefing] TODO取得エラー:', e.message);
    return `📋 TODO: 取得失敗\n（${e.message}）`;
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
    await buildTodoMsg(),
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
  const [tomorrowEvents, weekEvents] = await Promise.allSettled([
    cal.listEvents(tomorrowStr, 1),
    cal.listEvents(tomorrowStr, 7),
  ]).then(r => r.map(x => x.value || []));

  return [
    `🌙 ${dateLabel(now)} 夜のブリーフィングです。`,
    buildScheduleMsg(`明日 ${dateLabel(tomorrow)}`, tomorrowEvents),
    buildWeekMsg(weekEvents, dateLabel(tomorrow)),
    await buildMailMsg(gmail),
    await buildTodoMsg(),
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

// ── TODOリマインダー（期限3日前・前日・当日 7:00）──────
async function sendTodoReminders(lineClient) {
  const now = jstNow();
  const todayStr = toDateStr(now);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toDateStr(tomorrow);

  const in3 = new Date(now);
  in3.setDate(in3.getDate() + 3);
  const in3Str = toDateStr(in3);

  let items;
  try {
    items = await todo.list('pending');
  } catch (e) {
    console.error('[reminder] todo.list error:', e.message);
    return;
  }

  for (const t of items) {
    if (!t.due_date) continue;
    let label = null;
    if (t.due_date === todayStr)     label = `⏰ 今日が期限です！`;
    else if (t.due_date === tomorrowStr) label = `📅 明日が期限です`;
    else if (t.due_date === in3Str)      label = `🔔 3日後が期限です`;
    if (!label) continue;

    const msg = `${label}\n📋 ${t.title}\n期限: ${t.due_date.slice(5).replace('-', '/')}`;
    try {
      await lineClient.pushMessage(msg);
      console.log(`[reminder] 送信: ${t.title} (${t.due_date})`);
    } catch (e) {
      console.error(`[reminder] 送信失敗: ${t.title}:`, e.message);
    }
  }
}


if (require.main === module) {
  run().catch(async err => {
    console.error(err);
    // INVALID_GRANT 発生時はLINEで緊急通知
    if (String(err.message).includes('INVALID_GRANT')) {
      try {
        await lineClient.pushMessage(
          process.env.LINE_USER_ID,
          '🚨【要対応】Googleトークンが失効しました\n\nnode tools/setup.js を実行して再認証し、\nGitHub SecretsとRenderの\nRENDER_GOOGLE_TOKEN_JSONを両方更新してください'
        );
      } catch (_) { /* 通知失敗は無視 */ }
    }
    process.exit(1);
  });
}

module.exports = { generateMorning, generateEvening, sendTodoReminders };
