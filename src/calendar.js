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

class GoogleCalendarClient {
  constructor() {
    this.calendarId = 'primary';
  }

  _getCalendar() {
    return google.calendar({ version: 'v3', auth: getAuthClient() });
  }

  async listEvents(date, rangeDays = 1) {
    const calendar = this._getCalendar();
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

    return (res.data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '（タイトルなし）',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || '',
      description: e.description || '',
    }));
  }

  async checkConflict(start, end) {
    const calendar = this._getCalendar();
    // 境界値（ぴったり終わる/始まる）を重複と判定しないよう1分のバッファを設ける
    const tMin = new Date(new Date(start).getTime() + 60000).toISOString();
    const tMax = new Date(new Date(end).getTime() - 60000).toISOString();
    const res = await calendar.events.list({
      calendarId: this.calendarId,
      timeMin: tMin,
      timeMax: tMax,
      singleEvents: true,
    });
    return (res.data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '（タイトルなし）',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
    }));
  }

  async addEvent(title, start, end, description = '') {
    const conflicts = await this.checkConflict(start, end);
    if (conflicts.length > 0) {
      return { success: false, conflict: conflicts, event: null };
    }

    const calendar = this._getCalendar();
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
        id: res.data.id,
        title: res.data.summary,
        start: res.data.start.dateTime,
        end: res.data.end.dateTime,
      },
    };
  }

  async addEventForce(title, start, end, description = '') {
    const calendar = this._getCalendar();
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
        id: res.data.id,
        title: res.data.summary,
        start: res.data.start.dateTime,
        end: res.data.end.dateTime,
      },
    };
  }

  async deleteEvent(eventId) {
    const calendar = this._getCalendar();
    await calendar.events.delete({ calendarId: this.calendarId, eventId });
    return { success: true };
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
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');
    return this.listEvents(tomorrow, 1);
  }
}

module.exports = { GoogleCalendarClient };
