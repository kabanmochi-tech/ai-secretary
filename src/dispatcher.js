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

const AFFIRMATIVE = /^(はい|yes|ok|OK|送信|する|いいよ|お願い|大丈夫|よろしく|確定|登録|追加|削除)/i;
const NEGATIVE = /^(いいえ|no|キャンセル|やめて|やめる|中止|取り消し)/i;

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { pendingAction: null, pendingData: {}, lastMessages: [] });
  }
  return sessions.get(userId);
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

function formatEventLabel(params) {
  const start = new Date(params.start);
  const h = String(start.getHours()).padStart(2, '0');
  const m = String(start.getMinutes()).padStart(2, '0');
  const end = new Date(params.end);
  const eh = String(end.getHours()).padStart(2, '0');
  const em = String(end.getMinutes()).padStart(2, '0');
  const dateStr = params.start.slice(0, 10);
  return `${dateLabel(dateStr)} ${h}:${m}〜${eh}:${em}`;
}

async function executePending(session, replyToken) {
  const { pendingAction, pendingData } = session;
  clearPending(session);

  switch (pendingAction) {
    case 'calendar_add':
    case 'calendar_add_force': {
      const { title, start, end, description } = pendingData;
      try {
        // force の場合は重複チェックをスキップして直接追加
        const result = await calendarClient.addEventForce(title, start, end, description || '');
        const label = formatEventLabel({ start, end });
        await lineClient.replyMessage(replyToken, `✅ 追加しました\n${title}\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `❌ 追加に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'gmail_send': {
      const { draftId } = pendingData;
      await gmailClient.sendDraft(draftId);
      await lineClient.replyMessage(replyToken, '✅ 送信しました');
      return;
    }

    case 'calendar_delete': {
      const { eventId } = pendingData;
      await calendarClient.deleteEvent(eventId);
      await lineClient.replyMessage(replyToken, '🗑 削除しました');
      return;
    }

    case 'todo_delete': {
      const { id } = pendingData;
      todo.delete(id);
      await lineClient.replyMessage(replyToken, '🗑 削除しました');
      return;
    }

    default:
      await lineClient.replyMessage(replyToken, '操作がキャンセルされました');
  }
}

async function dispatch(userId, userMessage, replyToken) {
  const session = getSession(userId);

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

  // 意図解釈
  const intent = await ai.parseIntent(userMessage, {
    recentMessages: session.lastMessages,
    pendingAction: session.pendingAction,
  });

  session.lastMessages.push({ role: 'user', content: userMessage });
  if (session.lastMessages.length > 6) session.lastMessages.shift();

  const { action, params, reply, needs_confirm } = intent;

  switch (action) {
    case 'calendar_list': {
      try {
        const events = await calendarClient.listEvents(params.date, params.range_days || 1);
        const label = dateLabel(params.date);
        const text = formatCalendarEvents(events, label);
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
          const msg = `⚠️ 重複があります\n「${conflictNames}」が入っています。それでも追加しますか？`;
          session.pendingAction = 'calendar_add_force';
          session.pendingData = params;
          await lineClient.replyMessage(replyToken, msg);
          return;
        }
        const label = formatEventLabel(params);
        const confirmMsg = `「${params.title}」を\n${label}に追加してよいですか？`;
        session.pendingAction = 'calendar_add';
        session.pendingData = params;
        await lineClient.replyMessage(replyToken, confirmMsg);
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
        // 不動産物件紹介メールを自動除外するフィルター
        const EXCLUDE_REAL_ESTATE =
          '-subject:(物件紹介 OR 新着物件 OR 物件情報 OR 不動産情報 OR 賃貸物件 OR 売買物件 OR マンション情報 OR "物件のご紹介" OR "新着のご案内" OR "おすすめ物件" OR "物件特集")' +
          ' -from:(homes.co.jp OR suumo.jp OR athome.co.jp OR chintai.com OR realestate)';
        const baseQuery = params.query || 'is:unread';
        const query = baseQuery + ' ' + EXCLUDE_REAL_ESTATE;
        const emails = await gmailClient.listUnread(params.max || 5, query);
        const text = formatGmailList(emails);
        await lineClient.replyMessage(replyToken, text);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メールの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_draft': {
      try {
        let originalBody = '';
        let originalInfo = '';
        if (params.reply_to_id) {
          const original = await gmailClient.readMessage(params.reply_to_id);
          originalBody = original.body.slice(0, 500);
          originalInfo = `差出人: ${original.from}\n件名: ${original.subject}\n本文:\n${originalBody}`;
        }

        const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。
簡潔・丁寧なメール文面を作成してください。
署名は不要です。本文のみ出力してください。`;
        const userPrompt = params.body
          + (originalInfo ? `\n\n--- 返信元メール ---\n${originalInfo}` : '');

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
      const added = todo.add(params.title, params.due_date || null, params.priority || 'normal');
      await lineClient.replyMessage(replyToken, `✅ TODOに追加しました\n${added.title}`);
      break;
    }

    case 'todo_list': {
      const items = todo.list(params.filter || 'pending');
      await lineClient.replyMessage(replyToken, todo.formatList(items));
      break;
    }

    case 'todo_done': {
      const result = todo.complete(params.id);
      if (result.success) {
        await lineClient.replyMessage(replyToken, '✅ 完了しました');
      } else {
        await lineClient.replyMessage(replyToken, '該当するTODOが見つかりません');
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
        const messages = await briefing.generate();
        await lineClient.replyMessages(replyToken, messages);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `ブリーフィング生成に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'unknown':
    default: {
      const helpText = reply || `すみません、もう少し具体的に教えていただけますか？\n\n例:\n・「明日の予定教えて」\n・「田中さんにメール返信して」\n・「TODOに○○を追加して」`;
      await lineClient.replyMessage(replyToken, helpText);
    }
  }
}

module.exports = { dispatch };
