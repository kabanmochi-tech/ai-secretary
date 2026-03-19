'use strict';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const levels = { debug: 0, info: 1, warn: 2, error: 3 };

function format(level, mod, message, data) {
  const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const base = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${mod.padEnd(10)}] ${message}`;
  return data != null ? `${base} ${JSON.stringify(data)}` : base;
}

module.exports = {
  debug: (mod, msg, data) => { if (levels[LOG_LEVEL] <= 0) console.log(format('debug', mod, msg, data)); },
  info:  (mod, msg, data) => { if (levels[LOG_LEVEL] <= 1) console.log(format('info',  mod, msg, data)); },
  warn:  (mod, msg, data) => { if (levels[LOG_LEVEL] <= 2) console.warn(format('warn',  mod, msg, data)); },
  error: (mod, msg, data) => { if (levels[LOG_LEVEL] <= 3) console.error(format('error', mod, msg, data)); },
};
