/**
 * logger.js — シンプルなロガーモジュール
 *
 * 使い方:
 *   const logger = require('./lib/logger');
 *   logger.info('module', 'メッセージ', { key: 'value' });
 *   logger.warn('module', '警告メッセージ');
 *   logger.error('module', 'エラーメッセージ', { error: err.message });
 *   logger.debug('module', 'デバッグ情報');
 */

'use strict';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function format(level, module, message, extra) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [${module}] ${message}`;
  if (extra && typeof extra === 'object' && Object.keys(extra).length > 0) {
    try {
      return `${base} ${JSON.stringify(extra)}`;
    } catch {
      return base;
    }
  }
  return base;
}

function log(level, module, message, extra = {}) {
  if ((LEVELS[level] ?? 0) < currentLevel) return;
  const line = format(level, module, message, extra);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const logger = {
  debug: (module, message, extra) => log('debug', module, message, extra),
  info:  (module, message, extra) => log('info',  module, message, extra),
  warn:  (module, message, extra) => log('warn',  module, message, extra),
  error: (module, message, extra) => log('error', module, message, extra),
};

module.exports = logger;
