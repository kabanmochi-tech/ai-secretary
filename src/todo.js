require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./lib/google_auth');
const logger = require('./lib/logger');

async function getTasks() {
  const auth = await getAuthClient();
  return google.tasks({ version: 'v1', auth });
}

const PRIORITY_ICON = { high: '🔴', normal: '🟡', low: '🟢' };
const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };

// Google Tasksのnotesフィールドに優先度を保存するためのヘルパー
function encodePriority(priority) {
  return `priority:${priority || 'normal'}`;
}
function decodePriority(notes) {
  const m = (notes || '').match(/priority:(high|normal|low)/);
  return m ? m[1] : 'normal';
}

// Google Tasks の日付形式: RFC3339（due は "YYYY-MM-DDT00:00:00.000Z"）
// ※ JST midnight を UTC に変換すると日付が1日ずれるため、
//    意図した日付を UTC midnight で送信することで日付を正確に保持する
function dueDateToRfc(dateStr) {
  if (!dateStr) return undefined;
  return `${dateStr}T00:00:00.000Z`; // midnight UTC = 日付が正確に保持される
}
function rfcToDueDate(rfc) {
  if (!rfc) return null;
  // Google Tasks は due を "YYYY-MM-DDT00:00:00.000Z" で返す
  // midnight UTC の場合、スライスするだけで正確な日付が取れる
  return rfc.slice(0, 10);
}

async function add(title, dueDate = null, priority = 'normal') {
  try {
    const tasks = await getTasks();
    const body = {
      title,
      notes: encodePriority(priority),
      status: 'needsAction',
    };
    if (dueDate) body.due = dueDateToRfc(dueDate);

    const res = await tasks.tasks.insert({ tasklist: '@default', requestBody: body });
    return {
      id: res?.data?.id,
      title: res?.data?.title,
      due_date: rfcToDueDate(res?.data?.due),
      priority,
      completed: false,
    };
  } catch (e) {
    logger.error('todo', 'add失敗', { error: e.message });
    throw e;
  }
}

async function list(filter = 'pending') {
  try {
    const tasks = await getTasks();
    const params = {
      tasklist: '@default',
      maxResults: 50,
      showCompleted: filter === 'all',
      showHidden: filter === 'all',
    };
    if (filter === 'today') {
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      params.dueMax = todayEnd.toISOString();
    }

    const res = await tasks.tasks.list(params);
    const items = (res?.data?.items || []).filter(t => {
      if (filter === 'pending') return t.status !== 'completed';
      if (filter === 'completed') return t.status === 'completed';
      if (filter === 'today') {
        const due = rfcToDueDate(t.due);
        const todayStr = new Date().toLocaleDateString('ja-JP', {
          timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
        }).replace(/\//g, '-');
        return t.status !== 'completed' && due === todayStr;
      }
      return true;
    });

    return items.map(t => ({
      id: t.id,
      title: t.title,
      due_date: rfcToDueDate(t.due),
      priority: decodePriority(t.notes),
      completed: t.status === 'completed',
    }));
  } catch (e) {
    logger.error('todo', 'list失敗', { error: e.message });
    throw e;
  }
}

async function complete(id) {
  try {
    const tasks = await getTasks();
    await tasks.tasks.patch({
      tasklist: '@default',
      task: id,
      requestBody: { status: 'completed' },
    });
    return { success: true };
  } catch (e) {
    logger.warn('todo', 'complete失敗', { id, error: e.message });
    return { success: false, error: 'not found' };
  }
}

async function deleteTodo(id) {
  try {
    const tasks = await getTasks();
    await tasks.tasks.delete({ tasklist: '@default', task: id });
    return { success: true };
  } catch (e) {
    logger.warn('todo', 'delete失敗', { id, error: e.message });
    return { success: false };
  }
}

async function getTodayDue() {
  return list('today');
}

async function formatList(todosOrPromise) {
  try {
    const todos = Array.isArray(todosOrPromise) ? todosOrPromise : await todosOrPromise;
    if (!todos || todos.length === 0) return '📋 TODOはありません';

    const lines = [`📋 TODO（${todos.length}件）`, '━━━━━━━━━━'];
    for (const t of todos) {
      const icon = PRIORITY_ICON[t.priority] || '🟡';
      const label = PRIORITY_LABEL[t.priority] || '中';
      const due = t.due_date ? `（期限: ${t.due_date.slice(5).replace('-', '/')}）` : '';
      lines.push(`${icon} [${label}] ${t.title}${due}`);
    }
    return lines.join('\n');
  } catch (e) {
    logger.error('todo', 'formatList失敗', { error: e.message });
    return '📋 TODO一覧の整形に失敗しました';
  }
}

// キーワードでTODOを検索してメモ（notes）を更新する
async function addNote(keyword, note) {
  try {
    const tasks = await getTasks();
    const allPending = await list('pending');
    const target = keyword
      ? allPending.find(t =>
          t.title.includes(keyword) ||
          keyword.includes(t.title.replace(/^【[^】]*】/, '').trim())
        )
      : null;
    if (!target) return null;
    // 優先度プレフィックスを維持しつつメモを追記
    const priorityPrefix = encodePriority(target.priority || 'normal');
    const newNotes = `${priorityPrefix}\n📝 ${note}`;
    await tasks.tasks.patch({
      tasklist: '@default',
      task: target.id,
      requestBody: { notes: newNotes },
    });
    return target;
  } catch (e) {
    logger.error('todo', 'addNote失敗', { error: e.message });
    throw e;
  }
}

// キーワードでTODOを検索して完了にする
async function completeByKeyword(keyword) {
  try {
    const tasks = await getTasks();
    const allPending = await list('pending');
    const target = keyword
      ? allPending.find(t =>
          t.title.includes(keyword) ||
          keyword.includes(t.title.replace(/^【[^】]*】/, '').trim())
        )
      : null;
    if (!target) return null;
    await tasks.tasks.patch({
      tasklist: '@default',
      task: target.id,
      requestBody: { status: 'completed' },
    });
    return target;
  } catch (e) {
    logger.error('todo', 'completeByKeyword失敗', { error: e.message });
    throw e;
  }
}

module.exports = { add, list, complete, completeByKeyword, addNote, delete: deleteTodo, getTodayDue, formatList };
