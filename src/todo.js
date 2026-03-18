let todos = [];
let nextId = 1;

function add(title, dueDate = null, priority = 'normal') {
  const todo = {
    id: nextId++,
    title,
    due_date: dueDate,
    priority,
    completed: false,
    created_at: new Date().toISOString(),
  };
  todos.push(todo);
  return todo;
}

function list(filter = 'pending') {
  const todayStr = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\//g, '-');

  switch (filter) {
    case 'all':
      return [...todos];
    case 'today':
      return todos.filter(t => !t.completed && t.due_date === todayStr);
    case 'pending':
    default:
      return todos.filter(t => !t.completed);
  }
}

function complete(id) {
  const todo = todos.find(t => t.id === id);
  if (!todo) return { success: false, error: 'not found' };
  todo.completed = true;
  return { success: true };
}

function deleteTodo(id) {
  const idx = todos.findIndex(t => t.id === id);
  if (idx === -1) return { success: false };
  todos.splice(idx, 1);
  return { success: true };
}

function getTodayDue() {
  return list('today');
}

const PRIORITY_ICON = { high: '🔴', normal: '🟡', low: '🟢' };
const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };

function formatList(items) {
  if (!items || items.length === 0) return '📋 TODOはありません';

  const lines = [`📋 TODO（${items.length}件）`, '━━━━━━━━━━'];
  for (const t of items) {
    const icon = PRIORITY_ICON[t.priority] || '🟡';
    const label = PRIORITY_LABEL[t.priority] || '中';
    const due = t.due_date
      ? `（期限: ${t.due_date.slice(5).replace('-', '/')}）`
      : '';
    lines.push(`${icon} [${label}] ${t.title}${due}`);
  }
  return lines.join('\n');
}

module.exports = { add, list, complete, delete: deleteTodo, getTodayDue, formatList };
