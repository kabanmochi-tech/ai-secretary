require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./lib/google_auth');
const logger = require('./lib/logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, maxRetries = 2, delayMs = 3000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status || e?.code;
      if (attempt < maxRetries && (status >= 500 || status === 'ECONNRESET')) {
        logger.warn('calendar', `API失敗、リトライ ${attempt + 1}/${maxRetries}`, { status });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

class GoogleCalendarClient {
  constructor() {
    this.calendarId = 'primary';
  }

  async _getCalendar() {
    const auth = await getAuthClient();
    return google.calendar({ version: 'v3', auth });
  }

  async listEvents(date, rangeDays = 1) {
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const start = new Date(`${date}T00:00:00+09:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + rangeDays);

      const res = await calendar.events.list({
        calendarId: this.calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return (res?.data?.items || []).map(e => ({
        id: e.id,
        title: e.summary || '（タイトルなし）',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location || '',
        description: e.description || '',
      }));
    });
  }

  async checkConflict(start, end) {
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      // 境界値（ぴったり終わる/始まる）を重複と判定しないよう1分のバッファを設ける
      const tMin = new Date(new Date(start).getTime() + 60000).toISOString();
      const tMax = new Date(new Date(end).getTime() - 60000).toISOString();
      const res = await calendar.events.list({
        calendarId: this.calendarId,
        timeMin: tMin,
        timeMax: tMax,
        singleEvents: true,
      });
      return (res?.data?.items || []).map(e => ({
        id: e.id,
        title: e.summary || '（タイトルなし）',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      }));
    });
  }

  async addEvent(title, start, end, description = '') {
    if (new Date(start) >= new Date(end)) {
      throw new Error('終了時刻が開始時刻より前または同じです');
    }
    const conflicts = await this.checkConflict(start, end);
    if (conflicts.length > 0) {
      return { success: false, conflict: conflicts, event: null };
    }

    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const res = await calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: title,
          description,
          start: { dateTime: start, timeZone: 'Asia/Tokyo' },
          end: { dateTime: end, timeZone: 'Asia/Tokyo' },
        },
      });

      return {
        success: true,
        conflict: [],
        event: {
          id: res?.data?.id,
          title: res?.data?.summary,
          start: res?.data?.start?.dateTime,
          end: res?.data?.end?.dateTime,
        },
      };
    });
  }

  async addEventForce(title, start, end, description = '') {
    if (new Date(start) >= new Date(end)) {
      throw new Error('終了時刻が開始時刻より前または同じです');
    }
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const res = await calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: title,
          description,
          start: { dateTime: start, timeZone: 'Asia/Tokyo' },
          end: { dateTime: end, timeZone: 'Asia/Tokyo' },
        },
      });
      return {
        success: true,
        event: {
          id: res?.data?.id,
          title: res?.data?.summary,
          start: res?.data?.start?.dateTime,
          end: res?.data?.end?.dateTime,
        },
      };
    });
  }

  // キーワード・日付でイベント検索（delete/update前の検索用）
  async searchEvents(keyword, dateStr = null) {
    return withRetry(async () => {
      const now = new Date();
      const from = dateStr
        ? new Date(`${dateStr}T00:00:00+09:00`)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7); // 1週間前から
      const to = dateStr
        ? new Date(`${dateStr}T23:59:59+09:00`)
        : new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000); // 30日間

      const calendar = await this._getCalendar();
      const res = await calendar.events.list({
        calendarId: this.calendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        q: keyword, // Google Calendar APIの全文検索
      });
      return (res?.data?.items || []).map(e => ({
        id: e.id,
        title: e.summary || '（タイトルなし）',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      }));
    });
  }

  async deleteEvent(eventId) {
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      await calendar.events.delete({ calendarId: this.calendarId, eventId });
      return { success: true };
    });
  }

  async updateEvent(eventId, updates = {}) {
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const body = {};
      if (updates.title) body.summary = updates.title;
      if (updates.start) body.start = { dateTime: updates.start, timeZone: 'Asia/Tokyo' };
      if (updates.end)   body.end   = { dateTime: updates.end,   timeZone: 'Asia/Tokyo' };
      const res = await calendar.events.patch({
        calendarId: this.calendarId,
        eventId,
        requestBody: body,
      });
      return {
        success: true,
        event: {
          id: res?.data?.id,
          title: res?.data?.summary,
          start: (res?.data?.start || {}).dateTime || (res?.data?.start || {}).date,
          end:   (res?.data?.end   || {}).dateTime || (res?.data?.end   || {}).date,
        },
      };
    });
  }

  // 毎月第N曜日などの繰り返しカレンダーイベントを作成
  // rrule例: "FREQ=MONTHLY;BYDAY=2FR" （毎月第2金曜）
  async addRecurringEvent(title, rrule, startDate, startTime = '09:00', endTime = '09:30', description = '') {
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const res = await calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: title,
          description,
          start: { dateTime: `${startDate}T${startTime}:00`, timeZone: 'Asia/Tokyo' },
          end:   { dateTime: `${startDate}T${endTime}:00`,   timeZone: 'Asia/Tokyo' },
          recurrence: [`RRULE:${rrule}`],
        },
      });
      return {
        success: true,
        event: { id: res?.data?.id, title: res?.data?.summary, rrule },
      };
    });
  }

  async getTodayEvents() {
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');
    return this.listEvents(today, 1);
  }

  async getTomorrowEvents() {
    // JST基準で「明日」の日付を取得（Date.now()+86400000はDST/UTC境界で誤る可能性があるため修正）
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    now.setDate(now.getDate() + 1);
    const tomorrow = now.toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');
    return this.listEvents(tomorrow, 1);
  }
}

module.exports = { GoogleCalendarClient };
