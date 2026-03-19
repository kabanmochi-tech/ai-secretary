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
const RRULE_WD = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
const RRULE_WD_JA = { SU:'日', MO:'月', TU:'火', WE:'水', TH:'木', FR:'金', SA:'土' };

// RRULE文字列から次回実施日を計算（FREQ=MONTHLY;BYDAY=2FR など）
function calcNextRruleDate(rrule) {
  const now = jstNow();
  const mByday = rrule.match(/BYDAY=(-?\d+)([A-Z]{2})/);
  if (!mByday) {
    // フォールバック: 今日
    return toDateStr(now);
  }
  const nth = parseInt(mByday[1]);
  const wd = RRULE_WD[mByday[2]] ?? 5; // デフォルト金曜

  function findNthWeekdayInMonth(year, month, n, weekday) {
    let d = new Date(year, month, 1);
    let count = 0;
    while (d.getMonth() === month) {
      if (d.getDay() === weekday) {
        count++;
        if (count === n) return d;
      }
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  let d = findNthWeekdayInMonth(now.getFullYear(), now.getMonth(), nth, wd);
  if (!d || d <= now) {
    // 来月を使う
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    d = findNthWeekdayInMonth(next.getFullYear(), next.getMonth(), nth, wd);
  }
  return d ? toDateStr(d) : toDateStr(now);
}

// RRULE を日本語に変換
function formatRrule(rrule) {
  const mByday = rrule && rrule.match(/BYDAY=(-?\d+)([A-Z]{2})/);
  if (mByday) {
    const nth = parseInt(mByday[1]);
    const wdJa = RRULE_WD_JA[mByday[2]] || mByday[2];
    return `毎月第${nth}${wdJa}曜日`;
  }
  if (/FREQ=WEEKLY/.test(rrule)) return '毎週';
  if (/FREQ=MONTHLY/.test(rrule)) return '毎月';
  return rrule;
}

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
    sessions.set(userId, {
      pendingAction: null,
      pendingData: {},
      lastMessages: [],
      lastEmails: [],
      lastTodos: [],
      lastEvents: [],
      lastDraftId: null,
      lastDraftPreview: '',
      lastDraftInfo: null,
    });
  }
  return sessions.get(userId);
}

// ①②③からTODOを解決
function resolveTodoRef(msg, lastTodos) {
  for (let i = 0; i < NUM_CHARS.length; i++) {
    if (msg.includes(NUM_CHARS[i]) && lastTodos[i]) return { todo: lastTodos[i], num: i + 1 };
  }
  const m = msg.match(/([1-9１-９])(?:番|番目|つ目)?(?:の)?(?:タスク|TODO)/);
  if (m) {
    const idx = parseInt(m[1]) - 1;
    if (lastTodos[idx]) return { todo: lastTodos[idx], num: idx + 1 };
  }
  return null;
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
      const { id, title } = pendingData;
      try {
        await todo.delete(id);
        await lineClient.replyMessage(replyToken, `🗑 削除しました${title ? `\n${title}` : ''}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'calendar_update': {
      const { eventId, updates } = pendingData;
      try {
        const result = await calendarClient.updateEvent(eventId, updates);
        const label = formatEventLabel({ start: result.event.start, end: result.event.end });
        await lineClient.replyMessage(replyToken, `✅ 変更しました\n${result.event.title}\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `変更に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'todo_delete_by_title': {
      const { toDelete } = pendingData;
      try {
        for (const t of toDelete) {
          await todo.delete(t.id);
        }
        const deletedList = toDelete.map(t => `・${t.title}`).join('\n');
        await lineClient.replyMessage(replyToken,
          `🗑 ${toDelete.length}件のTODOを削除しました\n${deletedList}`
        );
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
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

// メッセージから「N件」「N通」を抽出する
function parseEmailCount(msg) {
  const m = msg.match(/(\d+)[件通]/);
  return m ? Math.min(parseInt(m[1]), 10) : 5; // 最大10件に制限
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

  // 「ドラフトに署名/本文を追加」→ 現在の下書きを更新して再プレビュー
  if (session.lastDraftId && /署名|本文.*追加|追記|ドラフト.*修正|下書き.*修正/.test(userMessage)) {
    try {
      // 既存ドラフトを取得してAIで本文を更新
      const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。既存のメール本文に指示の内容を追加・修正してください。本文のみ出力してください。`;
      const instruction = userMessage;
      // Note: gmailClient.getDraft は実装されていないため、AIに指示だけ渡して新規ドラフトを作成
      // lastDraftPreview があれば利用
      const prevPreview = session.lastDraftPreview || '';
      const userPrompt = `以下のメール本文に指示を適用してください。\n指示: ${instruction}\n\n既存本文（冒頭のみ）:\n${prevPreview}`;
      const newBody = await ai.generateReply(systemPrompt, userPrompt);
      // 新しいドラフトを作成（既存は削除せず上書き用に新規作成）
      const draftInfo = session.lastDraftInfo || {};
      const draft = await gmailClient.createDraft(
        draftInfo.to || '',
        draftInfo.subject || '（件名なし）',
        newBody,
        draftInfo.replyToId || null
      );
      const previewMsg = `署名を追加しました。送信しますか？\n\n─────\n${draft.preview}…\n─────`;
      session.pendingAction = 'gmail_send';
      session.pendingData = { draftId: draft.draftId };
      session.lastDraftId = draft.draftId;
      session.lastDraftPreview = draft.preview;
      await lineClient.replyMessage(replyToken, previewMsg);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `下書き修正に失敗しました: ${e.message}`);
    }
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

  // 「①のタスクを完了/削除にして」→ 番号でTODO参照
  const todoRef = resolveTodoRef(userMessage, session.lastTodos || []);
  if (todoRef) {
    if (/完了|終わった|done|済み/i.test(userMessage)) {
      try {
        await todo.complete(todoRef.todo.id);
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${todoRef.todo.title}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      return;
    }
    if (/削除|消して|消す|delete/i.test(userMessage)) {
      session.pendingAction = 'todo_delete';
      session.pendingData = { id: todoRef.todo.id, title: todoRef.todo.title };
      await lineClient.replyMessage(replyToken, `「${todoRef.todo.title}」を削除しますか？`);
      return;
    }
  }

  // 「直近/最新のメールに返信」→ lastEmails[0] を使用
  if (/直近|最新|さっき.*メール|最初|最後|一番上/.test(userMessage) && /返信|reply/i.test(userMessage)) {
    const latestEmail = (session.lastEmails || [])[0];
    if (latestEmail) {
      try {
        const original = await gmailClient.readMessage(latestEmail.id);
        const instruction = userMessage.replace(/直近|最新|さっき|最初|最後|一番上|のメール|に返信して?|返信ドラフト.*作って?/g, '').trim();
        const bodyInstruction = userMessage.match(/[『「](.*?)[』」]/) ? userMessage.match(/[『「](.*?)[』」]/)[1] : instruction;
        const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
        const userPrompt = `以下の指示でメールを返信してください。\n指示: ${bodyInstruction}\n\n--- 返信元メール ---\nFrom: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
        const bodyText = await ai.generateReply(systemPrompt, userPrompt);
        const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
        const draft = await gmailClient.createDraft(original.from, subject, bodyText, latestEmail.id);
        const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n宛先: ${original.from}\n件名: ${subject}\n─────\n${draft.preview}…\n─────`;
        session.pendingAction = 'gmail_send';
        session.pendingData = { draftId: draft.draftId };
        session.lastDraftId = draft.draftId;
        session.lastDraftPreview = draft.preview;
        session.lastDraftInfo = { to: original.from, subject, replyToId: latestEmail.id };
        await lineClient.replyMessage(replyToken, previewMsg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `返信の作成に失敗しました: ${e.message}`);
      }
      return;
    }
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
      session.lastDraftId = draft.draftId;
      session.lastDraftPreview = draft.preview;
      session.lastDraftInfo = { to: original.from, subject, replyToId: refEmail.id };
      await lineClient.replyMessage(replyToken, previewMsg);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `返信の作成に失敗しました: ${e.message}`);
    }
    return;
  }

  // TODO操作をキーワードで確実に判定
  if (/TODO/i.test(userMessage)) {
    // ── 削除を最優先でルーティング（「下記のtodo消して」が誤登録されるバグ対策）──
    if (/消して|削除|消去|delete/i.test(userMessage)) {
      try {
        // 「2. タイトル」「③ タイトル」「・タイトル」などの箇条書きからタイトルを抽出
        const titleLines = userMessage
          .split(/\n/)
          .map(l => l.replace(/^[\s　]*[\d①-⑩]+[\.。、\s　]/, '').trim())
          .filter(l => l.length > 2 && !/TODO|消して|削除|下記/i.test(l));

        // 「完了済み」を削除対象にする場合は completed フィルターを使う
        const deleteCompleted = /完了済み|済みタスク|completedタスク/i.test(userMessage);
        const filter = deleteCompleted ? 'completed' : 'pending';
        const isDeleteAll = titleLines.length === 0 && /全部|全て|すべて|all/i.test(userMessage);

        if (isDeleteAll || titleLines.length > 0 || deleteCompleted) {
          const allTodos = await todo.list(filter);
          const toDelete = isDeleteAll || (deleteCompleted && titleLines.length === 0)
            ? allTodos
            : allTodos.filter(t =>
                titleLines.some(target => {
                  const coreTitle = t.title.replace(/^【[^】]*】/, '').trim();
                  const coreTarget = target.replace(/^【[^】]*】/, '').trim();
                  if (!coreTarget) return false;
                  return t.title.includes(target) ||
                    coreTitle.includes(coreTarget) ||
                    coreTarget.includes(coreTitle);
                })
              );

          if (!toDelete.length) {
            await lineClient.replyMessage(replyToken,
              `該当するTODOが見つかりませんでした\n検索ワード: ${titleLines.join('、') || '(全件)'}`
            );
            return;
          }
          const previewList = toDelete.map(t => `・${t.title}`).join('\n');
          session.pendingAction = 'todo_delete_by_title';
          session.pendingData = { toDelete };
          await lineClient.replyMessage(replyToken,
            `以下の${toDelete.length}件のTODOを削除しますか？\n━━━━━━━━━━\n${previewList}`
          );
          return;
        }
      } catch (e) {
        console.error('[todo_delete keyword] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
        return;
      }
      // タイトルが抽出できなかった場合はAIへフォールスルー
    }

    if (/追加|ついか|加えて|入れて|add|登録/i.test(userMessage)) {
      // シンプルな1件追加（「TODOに〇〇を追加」形式）のみ直接処理
      // 複数項目・リマインド付きはAIへフォールスルー
      const flat = userMessage.replace(/\n|\r/g, ' ').trim();
      const hasMultipleItems = /[①-⑩]|（\d）|\(\d\)/.test(userMessage);
      const hasReminder = /リマインド|毎月|繰り返し|第[一二三四五]?[1-5]?金曜|毎週/.test(userMessage);
      const m = !hasMultipleItems && !hasReminder
        ? flat.match(/TODO[にへ]?[\s　]*(.+?)[\s　]*[をが]?[\s　]*(追加|加えて|入れて|add|登録)/i)
        : null;
      if (m) {
        let rawTitle = m[1].trim();
        // 期限は全メッセージから抽出（「追加して、期限は今週金曜」のようにタイトルの後ろに来る場合があるため）
        const dueDate = extractDueDate(userMessage);
        const cleanTitle = rawTitle
          .replace(/(\d{1,2})[\/月](\d{1,2})日?(?:まで|までに)?/g, '')
          .replace(/今日|本日|明日|明後日/g, '')
          .replace(/(今週|来週)?(月|火|水|木|金|土|日)曜(?:まで|までに)?/g, '')
          .replace(/期限(で|に|は|まで)?/g, '')
          .replace(/まで(に)?/g, '')
          .replace(/[「」『』【】]/g, '')
          .replace(/\s*[をが]\s*/g, '')
          .replace(/[\s　]+/g, ' ')
          .trim();
        const title = cleanTitle || rawTitle;
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
      // 複数項目・リマインド付き・タイトル取れない場合はAIへフォールスルー
    } else if (/完了|終わった|done|済み/.test(userMessage)) {
      // TODO完了もAIへフォールスルー
    } else if (/見せて|一覧|リスト|確認|表示|は？|教えて/.test(userMessage)) {
      // 「済み/完了タスク」はAIへ（completedフィルターが必要）
      if (!/済み|完了/.test(userMessage)) {
        try {
          const items = await todo.list('pending');
          session.lastTodos = items; // ①番号解決用に保存
          await lineClient.replyMessage(replyToken, await todo.formatList(items));
        } catch (e) {
          await lineClient.replyMessage(replyToken, `TODO一覧の取得に失敗しました: ${e.message}`);
        }
        return;
      }
    }
    // それ以外はAIへフォールスルー（複雑な要求はAIが解釈）
  }

  // メールキーワードは確実にメール一覧へ（todo追加・完了などと混同しないよう限定）
  if (/未読メール|メール見せて|メールチェック|inbox/i.test(userMessage)) {
    try {
      const maxCount = parseEmailCount(userMessage);
      await fetchAndShowEmails(session, replyToken, maxCount);
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
        let events = await calendarClient.listEvents(params.date, rangeDays);
        // 「残り予定」「これから」などのキーワードがある場合は現在時刻以降のみ表示
        if (/残り|これから|あと|まだ/.test(userMessage) && rangeDays === 1) {
          const nowJst = jstNow();
          events = events.filter(e => e.end && new Date(e.end) > nowJst);
        }
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
      // キーワードで検索してから確認
      try {
        const found = await calendarClient.searchEvents(params.keyword || '', params.date || null);
        if (!found.length) {
          await lineClient.replyMessage(replyToken, `「${params.keyword}」に該当する予定が見つかりませんでした`);
          break;
        }
        if (found.length === 1) {
          const ev = found[0];
          const label = formatEventLabel({ start: ev.start, end: ev.end });
          session.pendingAction = 'calendar_delete';
          session.pendingData = { eventId: ev.id };
          await lineClient.replyMessage(replyToken, `この予定を削除しますか？\n「${ev.title}」\n${label}`);
        } else {
          // 複数ヒット → 最初の3件を表示して絞り込み依頼
          const list = found.slice(0, 3).map((ev, i) => {
            const label = formatEventLabel({ start: ev.start, end: ev.end });
            return `${NUM_CHARS[i]} ${ev.title} ${label}`;
          }).join('\n');
          session.lastEvents = found.slice(0, 3);
          await lineClient.replyMessage(replyToken, `複数の予定が見つかりました。どれを削除しますか？\n${list}`);
        }
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー検索に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_update': {
      // キーワードで検索してから変更
      try {
        const found = await calendarClient.searchEvents(params.keyword || '', params.date || null);
        if (!found.length) {
          await lineClient.replyMessage(replyToken, `「${params.keyword}」に該当する予定が見つかりませんでした`);
          break;
        }
        const ev = found[0]; // 最も近い1件を使用
        const updates = {};
        if (params.new_title) updates.title = params.new_title;
        if (params.new_start) updates.start = params.new_start;
        if (params.new_end)   updates.end   = params.new_end;
        // 開始時刻のみ変更の場合、元の長さを維持して終了時刻を自動計算（JST形式で返す）
        if (params.new_start && !params.new_end && ev.end) {
          const origDuration = new Date(ev.end).getTime() - new Date(ev.start).getTime();
          const newEndMs = new Date(params.new_start).getTime() + origDuration;
          // JST offset を維持した ISO 文字列に変換
          const newEndDate = new Date(newEndMs);
          const jstOffset = 9 * 60;
          const localMs = newEndDate.getTime() + jstOffset * 60000;
          const d = new Date(localMs);
          updates.end = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:00+09:00`;
        }
        const newStart = updates.start || ev.start;
        const newEnd   = updates.end   || ev.end;
        const label = formatEventLabel({ start: newStart, end: newEnd });
        session.pendingAction = 'calendar_update';
        session.pendingData = { eventId: ev.id, updates };
        await lineClient.replyMessage(replyToken,
          `「${ev.title}」を以下の内容に変更してよいですか？\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー変更に失敗しました: ${e.message}`);
      }
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
        session.lastDraftId = draft.draftId;
        session.lastDraftPreview = draft.preview;
        session.lastDraftInfo = { to: params.to, subject: params.subject, replyToId: params.reply_to_id || null };
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
        const filter = params.filter || 'pending';
        const items = await todo.list(filter);
        if (filter === 'pending') session.lastTodos = items; // ①番号解決用に保存
        const msg = await todo.formatList(items);
        // 完了済み一覧のヘッダーを変える
        const displayMsg = filter === 'completed'
          ? msg.replace('📋 TODO', '✅ 完了済みTODO')
          : msg;
        await lineClient.replyMessage(replyToken, displayMsg);
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

    case 'todo_done_by_keyword': {
      // タイトルの一部でTODOを検索して完了にする（「提案書のタスクを完了にして」など）
      const keyword = params.keyword || '';
      if (!keyword) {
        await lineClient.replyMessage(replyToken, 'どのタスクを完了にするか教えてください');
        break;
      }
      try {
        const completed = await todo.completeByKeyword(keyword);
        if (!completed) {
          await lineClient.replyMessage(replyToken,
            `「${keyword}」に該当するタスクが見つかりません。\nTODOリストを確認してください。`);
          break;
        }
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${completed.title}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_done_by_num': {
      // ①②③ 番号指定で完了
      const num = parseInt(params.num) - 1;
      const targetTodo = (session.lastTodos || [])[num];
      if (!targetTodo) {
        await lineClient.replyMessage(replyToken, `${params.num}番のTODOが見つかりません。先にTODO一覧を表示してください`);
        break;
      }
      try {
        await todo.complete(targetTodo.id);
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${targetTodo.title}`);
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

    case 'todo_delete_by_title': {
      // タイトルの部分一致でTODOを検索して削除（確認ステップあり）
      const rawTitles = (params.titles || []).filter(t => t && t.trim().length > 0);
      // isDeleteAll: 明示的に「全部」系キーワードがある場合のみ全削除
      // （titlesが空でも「全部」キーワードがなければ全削除しない安全設計）
      const isDeleteAll = rawTitles.length === 0 && /全部|全て|すべて|all/i.test(userMessage);
      // 完了済みタスクを削除対象にする場合
      const deleteCompleted = /完了済み|済みタスク|completedタスク/i.test(userMessage);
      const filter = deleteCompleted ? 'completed' : 'pending';

      if (!isDeleteAll && rawTitles.length === 0 && !deleteCompleted) {
        await lineClient.replyMessage(replyToken,
          '削除するタスクを指定してください\n例: 「提案書のTODOを消して」「完了済みタスクを削除して」'
        );
        break;
      }

      try {
        const allTodos = await todo.list(filter);
        const toDelete = isDeleteAll || (deleteCompleted && rawTitles.length === 0)
          ? allTodos
          : allTodos.filter(t =>
              rawTitles.some(target => {
                const coreTitle = t.title.replace(/^【[^】]*】/, '').trim();
                const coreTarget = target.replace(/^【[^】]*】/, '').trim();
                if (!coreTarget) return false;
                return t.title.includes(target) ||
                  coreTitle.includes(coreTarget) ||
                  coreTarget.includes(coreTitle);
              })
            );

        if (!toDelete.length) {
          await lineClient.replyMessage(replyToken,
            `該当するTODOが見つかりませんでした\n検索ワード: ${rawTitles.join('、') || '(全件)'}`
          );
          break;
        }

        const previewList = toDelete.map(t => `・${t.title}`).join('\n');
        session.pendingAction = 'todo_delete_by_title';
        session.pendingData = { toDelete };
        await lineClient.replyMessage(replyToken,
          `以下の${toDelete.length}件のTODOを削除しますか？\n━━━━━━━━━━\n${previewList}`
        );
      } catch (e) {
        console.error('[todo_delete_by_title] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_setup_recurring': {
      // 複数TODO一括登録 + 毎月繰り返しカレンダーリマインダー作成
      try {
        const todos = params.todos || [];
        const addedTitles = [];
        for (const item of todos) {
          const added = await todo.add(item.title, item.due_date || null, item.priority || 'normal');
          addedTitles.push(added.title);
        }

        let calMsg = '';
        if (params.reminder_rrule) {
          // 次の第N曜日を計算してリマインダーを作成
          const startDate = calcNextRruleDate(params.reminder_rrule);
          await calendarClient.addRecurringEvent(
            params.reminder_title || '毎月定例リマインド',
            params.reminder_rrule,
            startDate,
            '09:00',
            '09:30',
            params.reminder_description || addedTitles.join('\n')
          );
          calMsg = `\n\n📅 カレンダーに毎月の繰り返しリマインドを登録しました\n「${params.reminder_title || '毎月定例リマインド'}」`;
        }

        const todoList = addedTitles.map((t, i) => `${i+1}. ${t}`).join('\n');
        await lineClient.replyMessage(replyToken,
          `✅ ${addedTitles.length}件のTODOを登録しました\n━━━━━━━━━━\n${todoList}${calMsg}`
        );
      } catch (e) {
        console.error('[todo_setup_recurring] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO登録に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add_recurring': {
      // 繰り返しカレンダーイベントの作成
      try {
        const startDate = params.start_date || calcNextRruleDate(params.rrule || 'FREQ=MONTHLY;BYDAY=2FR');
        const result = await calendarClient.addRecurringEvent(
          params.title,
          params.rrule,
          startDate,
          params.start_time || '09:00',
          params.end_time || '09:30',
          params.description || ''
        );
        await lineClient.replyMessage(replyToken,
          `✅ 毎月の繰り返しリマインドを登録しました\n📅 ${result.event.title}\n（${formatRrule(params.rrule)}）`
        );
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー登録に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add_multi': {
      // 複数予定を一括追加（確認ステップなしで連続追加）
      const events = params.events || [];
      if (!events.length) {
        await lineClient.replyMessage(replyToken, '追加する予定が指定されていません');
        break;
      }
      try {
        const added = [];
        const failed = [];
        for (const ev of events) {
          try {
            const conflicts = await calendarClient.checkConflict(ev.start, ev.end);
            if (conflicts.length > 0) {
              await calendarClient.addEventForce(ev.title, ev.start, ev.end, ev.description || '');
            } else {
              await calendarClient.addEventForce(ev.title, ev.start, ev.end, ev.description || '');
            }
            added.push(`・${ev.title} ${formatEventLabel({ start: ev.start, end: ev.end })}`);
          } catch (err) {
            failed.push(`・${ev.title}（失敗: ${err.message}）`);
          }
        }
        let msg = `✅ ${added.length}件の予定を追加しました\n${added.join('\n')}`;
        if (failed.length) msg += `\n\n⚠️ 失敗した予定:\n${failed.join('\n')}`;
        await lineClient.replyMessage(replyToken, msg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `予定の追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_note': {
      // タスクにメモ/覚書を追加（todo.addNote() に委譲して認証重複を解消）
      try {
        const keyword = params.keyword || '';
        const note = params.note || '';
        if (!note) {
          await lineClient.replyMessage(replyToken, 'メモの内容を指定してください');
          break;
        }
        const target = await todo.addNote(keyword, note);
        if (!target) {
          await lineClient.replyMessage(replyToken,
            `「${keyword}」に該当するタスクが見つかりません。\nTODO一覧を確認してください。`);
          break;
        }
        await lineClient.replyMessage(replyToken, `📝 メモを追加しました\n${target.title}\n\n「${note}」`);
      } catch (e) {
        console.error('[todo_note] error:', e.message);
        await lineClient.replyMessage(replyToken, `メモの追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'briefing': {
      // replyTokenは30秒で失効するため、まず受付返答してからpushで送信
      await lineClient.replyMessage(replyToken, '📋 ブリーフィングを生成中です…');
      try {
        const messages = await briefing.generateMorning();
        await lineClient.pushMessages(messages);
      } catch (e) {
        await lineClient.pushMessage(`ブリーフィング生成に失敗しました: ${e.message}`);
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
