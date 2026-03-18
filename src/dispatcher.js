require('dotenv').config();
const ai = require('./ai');
const { GoogleCalendarClient } = require('./calendar');
const { GmailClient } = require('./gmail');
const todo = require('./todo');
const { LineClient, formatCalendarEvents, formatGmailList } = require('./line');
const briefing = require('./briefing');

const sessions = new Map();
const lineClient = new LineClient();
const calendarClient = new GoogleCalendarClient();
const gmailClient = new GmailClient();

const AFFIRMATIVE = /^(はい|yes|ok|OK|おけ|おk|おK|イエス|よい|よし|いいよ|いいです|送信|する|お願い|大丈夫|よろしく|確定|登録|追加|削除|合ってる|正しい|それで|問題ない)/i;
const NEGATIVE = /^(いいえ|no|キャンセル|やめて|やめる|中止|取り消し)/i;

// 不動産物件紹介メール除外フィルター（1箇所で管理）
const EXCLUDE_REAL_ESTATE =
  '-subject:(物件紹介 OR 新着物件 OR 物件情報 OR 不動産情報 OR 賃貸物件 OR 売買物件 OR マンション情報 OR "物件のご紹介" OR "新着のご案内" OR "おすすめ物件" OR "物件特集")' +
  ' -from:(homes.co.jp OR suumo.jp OR athome.co.jp OR chintai.com OR realestate)';

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// メッセージから期限日を抽出（JST基準）
function extractDueDate(msg) {
  const now = jstNow();
  const year = now.getFullYear();

  // 「3/25」「3月25日」「03/25」などにマッチ
  const mMD = msg.match(/(\d{1,2})[\/月](\d{1,2})日?(?:まで|までに)?/);
  if (mMD) {
    const month = parseInt(mMD[1]);
    const day = parseInt(mMD[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(year, month - 1, day);
      if (d < now) d = new Date(year + 1, month - 1, day); // 過去なら来年
      return toDateStr(d);
    }
  }
  // 「今日」「本日」
  if (/今日|本日/.test(msg)) return toDateStr(now);
  // 「明日」
  if (/明日/.test(msg)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return toDateStr(d);
  }
  // 「明後日」
  if (/明後日/.test(msg)) {
    const d = new Date(now); d.setDate(d.getDate() + 2); return toDateStr(d);
  }
  // 「今週〇曜」「来週〇曜」
  const mWD = msg.match(/(今週|来週)?(月|火|水|木|金|土|日)曜/);
  if (mWD) {
    const wdMap = { 日:0,月:1,火:2,水:3,木:4,金:5,土:6 };
    const target = wdMap[mWD[2]];
    const d = new Date(now);
    let diff = target - d.getDay();
    if (mWD[1] === '来週') diff += 7;
    else if (diff <= 0) diff += 7; // 今週で当日以前なら次週
    d.setDate(d.getDate() + diff);
    return toDateStr(d);
  }
  return null;
}

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { pendingAction: null, pendingData: {}, lastMessages: [], lastEmails: [] });
  }
  return sessions.get(userId);
}

// 「①」「②」などの番号からメールを解決する
const NUM_CHARS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
function resolveEmailRef(msg, lastEmails) {
  for (let i = 0; i < NUM_CHARS.length; i++) {
    if (msg.includes(NUM_CHARS[i]) && lastEmails[i]) {
      return lastEmails[i];
    }
  }
  const m = msg.match(/([1-9１-９])(?:番|番目|つ目)/);
  if (m) {
    const idx = parseInt(m[1]) - 1;
    if (lastEmails[idx]) return lastEmails[idx];
  }
  return null;
}

function clearPending(session) {
  session.pendingAction = null;
  session.pendingData = {};
}

function dateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const wd = WEEKDAY_JA[d.getDay()];
  return `${month}月${day}日（${wd}）`;
}

// 予定の確認メッセージ用時刻フォーマット（JST固定）
function formatEventLabel(params) {
  const s = new Date(params.start).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const e = new Date(params.end).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = params.start.slice(0, 10);
  return `${dateLabel(dateStr)} ${s}〜${e}`;
}

async function executePending(session, replyToken) {
  const { pendingAction, pendingData } = session;
  clearPending(session);

  switch (pendingAction) {
    case 'calendar_add':
    case 'calendar_add_force': {
      const { title, start, end, description } = pendingData;
      try {
        await calendarClient.addEventForce(title, start, end, description || '');
        const label = formatEventLabel({ start, end });
        await lineClient.replyMessage(replyToken, `✅ 追加しました\n${title}\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `❌ 追加に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'gmail_send': {
      const { draftId } = pendingData;
      try {
        await gmailClient.sendDraft(draftId);
        await lineClient.replyMessage(replyToken, '✅ 送信しました');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `送信に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'calendar_delete': {
      const { eventId } = pendingData;
      try {
        await calendarClient.deleteEvent(eventId);
        await lineClient.replyMessage(replyToken, '🗑 削除しました');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `削除に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'todo_delete': {
      const { id } = pendingData;
      await todo.delete(id);
      await lineClient.replyMessage(replyToken, '🗑 削除しました');
      return;
    }

    default:
      await lineClient.replyMessage(replyToken, 'キャンセルしました');
  }
}

// メール一覧取得の共通処理
async function fetchAndShowEmails(session, replyToken, max = 5) {
  const emails = await gmailClient.listUnread(max, `in:inbox is:unread ${EXCLUDE_REAL_ESTATE}`);
  session.lastEmails = emails;
  await lineClient.replyMessage(replyToken, formatGmailList(emails));
}

async function dispatch(userId, userMessage, replyToken) {
  const session = getSession(userId);

  // 表記ゆれを正規化（To do / to-do → TODO）
  userMessage = userMessage.replace(/[Tt]o[\s\-]?[Dd]o/g, 'TODO');

  // 肯定応答
  if (session.pendingAction && AFFIRMATIVE.test(userMessage.trim())) {
    await executePending(session, replyToken);
    return;
  }

  // 否定応答
  if (session.pendingAction && NEGATIVE.test(userMessage.trim())) {
    clearPending(session);
    await lineClient.replyMessage(replyToken, 'キャンセルしました');
    return;
  }

  // 「②をアーカイブ」→ 番号でメール参照して即アーカイブ（確認なし）
  const archiveRef = resolveEmailRef(userMessage, session.lastEmails || []);
  if (archiveRef && /アーカイブ|archive/i.test(userMessage)) {
    try {
      await gmailClient.archiveMessage(archiveRef.id);
      await lineClient.replyMessage(replyToken, `📦 アーカイブしました\n「${archiveRef.subject}」`);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `アーカイブに失敗しました: ${e.message}`);
    }
    return;
  }

  // 「①に〇〇と返信して」→ 番号でメール参照して返信処理
  const refEmail = resolveEmailRef(userMessage, session.lastEmails || []);
  if (refEmail && /返信|reply/i.test(userMessage)) {
    try {
      const original = await gmailClient.readMessage(refEmail.id);
      const instruction = userMessage.replace(/[①-⑩]|[1-9]番(目)?|返信して?|に$/, '').trim();
      const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
      const userPrompt = `以下の指示でメールを返信してください。\n指示: ${instruction}\n\n--- 返信元メール ---\nFrom: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
      const bodyText = await ai.generateReply(systemPrompt, userPrompt);
      const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
      const draft = await gmailClient.createDraft(original.from, subject, bodyText, refEmail.id);
      const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n宛先: ${original.from}\n件名: ${subject}\n─────\n${draft.preview}…\n─────`;
      session.pendingAction = 'gmail_send';
      session.pendingData = { draftId: draft.draftId };
      await lineClient.replyMessage(replyToken, previewMsg);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `返信の作成に失敗しました: ${e.message}`);
    }
    return;
  }

  // TODO操作をキーワードで確実に判定
  if (/TODO/i.test(userMessage)) {
    if (/追加|ついか|加えて|入れて|add/i.test(userMessage)) {
      // TODO追加 → 正規表現でタイトル・期限を直接抽出（AIの前回会話コンテキスト混入を防ぐ）
      const flat = userMessage.replace(/\n|\r/g, ' ').trim();
      // 「TODOに〇〇を追加」「TODOへ〇〇を追加」「TODO〇〇追加」などに対応
      const m = flat.match(/TODO[にへ]?[\s　]*(.+?)[\s　]*[をが]?[\s　]*(追加|加えて|入れて|add)/i);
      let rawTitle = m ? m[1].trim() : null;
      if (rawTitle) {
        // 期限を抽出し、タイトルから除去
        const dueDate = extractDueDate(rawTitle);
        const cleanTitle = rawTitle
          .replace(/(\d{1,2})[\/月](\d{1,2})日?(?:まで|までに)?/g, '')
          .replace(/今日|本日|明日|明後日/g, '')
          .replace(/(今週|来週)?(月|火|水|木|金|土|日)曜(?:まで|までに)?/g, '')
          .replace(/まで(に)?/g, '')
          .replace(/[\s　]+/g, ' ')
          .trim();
        const title = cleanTitle || rawTitle; // 空になったらrawTitle使用
        try {
          const added = await todo.add(title, dueDate, 'normal');
          const dueStr = dueDate ? `\n期限: ${dueDate.slice(5).replace('-','/')}` : '';
          await lineClient.replyMessage(replyToken, `✅ TODOに追加しました\n${added.title}${dueStr}`);
        } catch (e) {
          console.error('[todo_add] error:', e.message);
          await lineClient.replyMessage(replyToken, `TODO追加に失敗しました: ${e.message}`);
        }
        return;
      }
      // タイトルが取れない場合はAIへフォールスルー
    } else if (/完了|終わった|done|済み/i.test(userMessage)) {
      // TODO完了も同様にAIへ
    } else {
      // それ以外はTODO一覧表示
      try {
        const items = await todo.list('pending');
        await lineClient.replyMessage(replyToken, await todo.formatList(items));
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO一覧の取得に失敗しました: ${e.message}`);
      }
      return;
    }
  }

  // メールキーワードは確実にメール一覧へ（todo追加・完了などと混同しないよう限定）
  if (/未読メール|メール見せて|メールチェック|inbox/i.test(userMessage)) {
    try {
      await fetchAndShowEmails(session, replyToken);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `メールの取得に失敗しました: ${e.message}`);
    }
    return;
  }

  // 意図解釈（AI）
  const intent = await ai.parseIntent(userMessage, {
    recentMessages: session.lastMessages,
    pendingAction: session.pendingAction,
  });

  session.lastMessages.push({ role: 'user', content: userMessage });
  if (session.lastMessages.length > 6) session.lastMessages.shift();

  const { action, params, reply } = intent;

  switch (action) {
    case 'calendar_list': {
      try {
        const rangeDays = params.range_days || 1;
        const events = await calendarClient.listEvents(params.date, rangeDays);
        const label = rangeDays > 1 ? `${dateLabel(params.date)}〜` : dateLabel(params.date);
        const text = formatCalendarEvents(events, label, rangeDays);
        await lineClient.replyMessage(replyToken, text);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダーの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add': {
      try {
        const conflicts = await calendarClient.checkConflict(params.start, params.end);
        if (conflicts.length > 0) {
          const conflictNames = conflicts.map(c => c.title).join('、');
          session.pendingAction = 'calendar_add_force';
          session.pendingData = params;
          await lineClient.replyMessage(replyToken, `⚠️ 重複があります\n「${conflictNames}」が入っています。それでも追加しますか？`);
          return;
        }
        const label = formatEventLabel(params);
        session.pendingAction = 'calendar_add';
        session.pendingData = params;
        await lineClient.replyMessage(replyToken, `「${params.title}」を\n${label}に追加してよいですか？`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_delete': {
      session.pendingAction = 'calendar_delete';
      session.pendingData = { eventId: params.event_id };
      await lineClient.replyMessage(replyToken, `この予定を削除しますか？`);
      break;
    }

    case 'gmail_list': {
      try {
        const baseQuery = params.query || 'in:inbox is:unread';
        const emails = await gmailClient.listUnread(params.max || 5, `${baseQuery} ${EXCLUDE_REAL_ESTATE}`);
        session.lastEmails = emails;
        await lineClient.replyMessage(replyToken, formatGmailList(emails));
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メールの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_draft': {
      try {
        let originalInfo = '';
        if (params.reply_to_id) {
          const original = await gmailClient.readMessage(params.reply_to_id);
          originalInfo = `差出人: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
        }
        const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
        const userPrompt = params.body + (originalInfo ? `\n\n--- 返信元メール ---\n${originalInfo}` : '');
        const bodyText = await ai.generateReply(systemPrompt, userPrompt);
        const subject = params.subject || '（件名なし）';
        const draft = await gmailClient.createDraft(params.to, subject, bodyText, params.reply_to_id || null);
        const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n─────\n${draft.preview}…\n─────`;
        session.pendingAction = 'gmail_send';
        session.pendingData = { draftId: draft.draftId };
        await lineClient.replyMessage(replyToken, previewMsg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メール下書き作成に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_send': {
      if (params.draft_id) {
        try {
          await gmailClient.sendDraft(params.draft_id);
          await lineClient.replyMessage(replyToken, '✅ 送信しました');
        } catch (e) {
          await lineClient.replyMessage(replyToken, `送信に失敗しました: ${e.message}`);
        }
      } else {
        await lineClient.replyMessage(replyToken, 'draft_idが指定されていません');
      }
      break;
    }

    case 'gmail_read': {
      try {
        const msg = await gmailClient.readMessage(params.message_id);
        const text = `📧 ${msg.subject}\nFrom: ${msg.from}\n${msg.date}\n\n${msg.body.slice(0, 500)}`;
        await lineClient.replyMessage(replyToken, text);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メール読み取りに失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_add': {
      try {
        const added = await todo.add(params.title, params.due_date || null, params.priority || 'normal');
        await lineClient.replyMessage(replyToken, `✅ TODOに追加しました\n${added.title}`);
      } catch (e) {
        console.error('[todo_add] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_list': {
      try {
        const items = await todo.list(params.filter || 'pending');
        await lineClient.replyMessage(replyToken, await todo.formatList(items));
      } catch (e) {
        console.error('[todo_list] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO一覧の取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_done': {
      try {
        const result = await todo.complete(params.id);
        await lineClient.replyMessage(replyToken, result.success ? '✅ 完了しました' : '該当するTODOが見つかりません');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_delete': {
      session.pendingAction = 'todo_delete';
      session.pendingData = { id: params.id };
      await lineClient.replyMessage(replyToken, 'このTODOを削除しますか？');
      break;
    }

    case 'briefing': {
      try {
        const messages = await briefing.generateMorning();
        await lineClient.replyMessages(replyToken, messages);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `ブリーフィング生成に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'unknown':
    default: {
      const helpText = reply || `すみません、もう少し具体的に教えていただけますか？\n\n例:\n・「明日の予定教えて」\n・「未読メール見せて」\n・「TODOに○○を追加して」`;
      await lineClient.replyMessage(replyToken, helpText);
    }
  }
}

module.exports = { dispatch };
