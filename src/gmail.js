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

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(payload) {
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return decodeBase64(part.body.data).replace(/<[^>]+>/g, '');
      }
    }
  }
  return '';
}

class GmailClient {
  _getGmail() {
    return google.gmail({ version: 'v1', auth: getAuthClient() });
  }

  async listUnread(max = 5, query = '') {
    const gmail = this._getGmail();
    const q = query || 'is:unread';
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: max,
    });

    const items = res.data.messages || [];
    const results = [];
    for (const item of items) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'] });
      const headers = msg.data.payload.headers;
      results.push({
        id: msg.data.id,
        threadId: msg.data.threadId,
        from: getHeader(headers, 'From'),
        subject: getHeader(headers, 'Subject'),
        snippet: msg.data.snippet || '',
        date: getHeader(headers, 'Date'),
      });
    }
    return results;
  }

  async readMessage(messageId) {
    const gmail = this._getGmail();
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const headers = res.data.payload.headers;
    return {
      id: res.data.id,
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      subject: getHeader(headers, 'Subject'),
      body: extractBody(res.data.payload),
      date: getHeader(headers, 'Date'),
    };
  }

  async createDraft(to, subject, body, replyToId = null) {
    const gmail = this._getGmail();

    let threadId;
    let inReplyTo;
    let references;

    if (replyToId) {
      const original = await gmail.users.messages.get({ userId: 'me', id: replyToId, format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'] });
      threadId = original.data.threadId;
      inReplyTo = getHeader(original.data.payload.headers, 'Message-ID');
      references = getHeader(original.data.payload.headers, 'References');
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
      draftId: res.data.id,
      to,
      subject,
      preview: body.slice(0, 100),
    };
  }

  async sendDraft(draftId) {
    const gmail = this._getGmail();
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return { success: true, messageId: res.data.id };
  }

  async getUnreadCount() {
    const gmail = this._getGmail();
    const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 1 });
    return res.data.resultSizeEstimate || 0;
  }
}

module.exports = { GmailClient };
