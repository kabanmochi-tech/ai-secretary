require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function getAuthClient() {
  const tokenJson = process.env.RENDER_GOOGLE_TOKEN_JSON
    ? JSON.parse(process.env.RENDER_GOOGLE_TOKEN_JSON)
    : JSON.parse(fs.readFileSync(path.join(__dirname, '../tokens/google_token.json'), 'utf8'));

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
  );
  oauth2.setCredentials(tokenJson);
  return oauth2;
}

function getTasks() {
  return google.tasks({ version: 'v1', auth: getAuthClient() });
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
function dueDateToRfc(dateStr) {
  if (!dateStr) return undefined;
  return new Date(dateStr + 'T00:00:00+09:00').toISOString();
}
function rfcToDueDate(rfc) {
  if (!rfc) return null;
  return rfc.slice(0, 10);
}

async function add(title, dueDate = null, priority = 'normal') {
  const tasks = getTasks();
  const body = {
    title,
    notes: encodePriority(priority),
    status: 'needsAction',
  };
  if (dueDate) body.due = dueDateToRfc(dueDate);

  const res = await tasks.tasks.insert({ tasklist: '@default', requestBody: body });
  return {
    id: res.data.id,
    title: res.data.title,
    due_date: rfcToDueDate(res.data.due),
    priority,
    completed: false,
  };
}

async function list(filter = 'pending') {
  const tasks = getTasks();
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
  const items = (res.data.items || []).filter(t => {
    if (filter === 'pending') return t.status !== 'completed';
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
}

async function complete(id) {
  try {
    const tasks = getTasks();
    await tasks.tasks.patch({
      tasklist: '@default',
      task: id,
      requestBody: { status: 'completed' },
    });
    return { success: true };
  } catch {
    return { success: false, error: 'not found' };
  }
}

async function deleteTodo(id) {
  try {
    const tasks = getTasks();
    await tasks.tasks.delete({ tasklist: '@default', task: id });
    return { success: true };
  } catch {
    return { success: false };
  }
}

async function getTodayDue() {
  return list('today');
}

async function formatList(todosOrPromise) {
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
}

module.exports = { add, list, complete, delete: deleteTodo, getTodayDue, formatList };
