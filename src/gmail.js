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
        logger.warn('gmail', `API失敗、リトライ ${attempt + 1}/${maxRetries}`, { status });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

function isValidEmail(email) {
  return typeof email === 'string' && email.includes('@') && email.length > 3;
}

function decodeBase64(str) {
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(payload) {
  if (payload?.body?.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64(part.body.data).replace(/<[^>]+>/g, '');
      }
    }
  }
  return '';
}

class GmailClient {
  async _getGmail() {
    const auth = await getAuthClient();
    return google.gmail({ version: 'v1', auth });
  }

  async listUnread(max = 5, query = '') {
    return withRetry(async () => {
      const gmail = await this._getGmail();
      const q = query || 'is:unread';
      const res = await gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: max,
      });

      const items = res?.data?.messages || [];
      const results = [];
      for (const item of items) {
        const msg = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'] });
        const headers = msg?.data?.payload?.headers || [];
        results.push({
          id: msg?.data?.id,
          threadId: msg?.data?.threadId,
          from: getHeader(headers, 'From'),
          subject: getHeader(headers, 'Subject'),
          snippet: msg?.data?.snippet || '',
          date: getHeader(headers, 'Date'),
        });
      }
      return results;
    });
  }

  async readMessage(messageId) {
    return withRetry(async () => {
      const gmail = await this._getGmail();
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const headers = res?.data?.payload?.headers || [];
      return {
        id: res?.data?.id,
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        body: extractBody(res?.data?.payload),
        date: getHeader(headers, 'Date'),
      };
    });
  }

  async createDraft(to, subject, body, replyToId = null) {
    if (to && !isValidEmail(to)) {
      logger.warn('gmail', 'メールアドレスが無効です', { to });
    }
    return withRetry(async () => {
      const gmail = await this._getGmail();

      let threadId;
      let inReplyTo;
      let references;

      if (replyToId) {
        const original = await gmail.users.messages.get({ userId: 'me', id: replyToId, format: 'metadata',
          metadataHeaders: ['Message-ID', 'References'] });
        threadId = original?.data?.threadId;
        inReplyTo = getHeader(original?.data?.payload?.headers || [], 'Message-ID');
        references = getHeader(original?.data?.payload?.headers || [], 'References');
      }

      const rawLines = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'Content-Type: text/plain; charset=UTF-8',
        'MIME-Version: 1.0',
      ];
      if (inReplyTo) rawLines.push(`In-Reply-To: ${inReplyTo}`);
      if (references) rawLines.push(`References: ${references} ${inReplyTo}`);
      rawLines.push('', body);

      const raw = Buffer.from(rawLines.join('\r\n')).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const req = { userId: 'me', requestBody: { message: { raw } } };
      if (threadId) req.requestBody.message.threadId = threadId;

      const res = await gmail.users.drafts.create(req);
      return {
        draftId: res?.data?.id,
        to,
        subject,
        preview: body.slice(0, 100),
      };
    });
  }

  async sendDraft(draftId) {
    return withRetry(async () => {
      const gmail = await this._getGmail();
      const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
      const messageId = res?.data?.id;
      if (!messageId) {
        throw new Error('送信APIは成功しましたがメッセージIDが返りませんでした。Gmailの送信済みを確認してください');
      }
      logger.info('gmail', '送信成功', { messageId });
      return { success: true, messageId };
    });
  }

  async getUnreadCount() {
    return withRetry(async () => {
      const gmail = await this._getGmail();
      const res = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox is:unread', maxResults: 1 });
      return res?.data?.resultSizeEstimate || 0;
    });
  }

  async archiveMessage(messageId) {
    return withRetry(async () => {
      const gmail = await this._getGmail();
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['INBOX'] },
      });
      return { success: true };
    });
  }
}

module.exports = { GmailClient };
