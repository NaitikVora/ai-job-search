import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { logger } from '../log.js';
import { readJson, writeJson } from '../util/fs.js';

const log = logger('gmail');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface OAuthClient {
  client_id: string;
  client_secret: string;
}

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expiry: number; // epoch ms
  email?: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
  attachments?: Array<{ filename: string; contentType: string; data: Buffer }>;
  /** Reply headers for follow-ups. */
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface SentMail {
  id: string;
  threadId: string;
  messageIdHeader?: string;
}

/**
 * Gmail via the REST API with a hand-rolled OAuth 2.0 loopback flow (no googleapis dependency).
 * Credentials: a "Desktop app" OAuth client JSON from Google Cloud Console at
 * agent/secrets/gmail_credentials.json. Tokens are stored next to it.
 */
export class GmailClient {
  private client?: OAuthClient;
  private token?: StoredToken;

  constructor(
    private readonly credentialsFile: string,
    private readonly tokenFile: string,
    private readonly oauthPort: number,
  ) {
    this.client = this.loadClient();
    this.token = readJson<StoredToken | undefined>(tokenFile, undefined);
  }

  private loadClient(): OAuthClient | undefined {
    const raw = readJson<{ installed?: OAuthClient; web?: OAuthClient } | undefined>(this.credentialsFile, undefined);
    const c = raw?.installed ?? raw?.web;
    if (!c?.client_id || !c.client_secret) return undefined;
    return { client_id: c.client_id, client_secret: c.client_secret };
  }

  hasCredentials(): boolean {
    return Boolean(this.client);
  }

  isAuthorized(): boolean {
    return Boolean(this.token?.refresh_token || (this.token && this.token.expiry > Date.now()));
  }

  accountEmail(): string | undefined {
    return this.token?.email;
  }

  private redirectUri(): string {
    return `http://127.0.0.1:${this.oauthPort}/oauth2callback`;
  }

  /** Start the consent flow: returns the URL to open; resolves once the loopback receives the code. */
  authorize(): { url: string; done: Promise<string> } {
    if (!this.client) throw new Error(`Gmail credentials missing at ${this.credentialsFile}`);
    const state = randomBytes(12).toString('hex');
    const params = new URLSearchParams({
      client_id: this.client.client_id,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    const url = `${AUTH_URI}?${params.toString()}`;
    const done = new Promise<string>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.oauthPort}`);
          if (u.pathname !== '/oauth2callback') {
            res.writeHead(404).end();
            return;
          }
          if (u.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
          const code = u.searchParams.get('code');
          if (!code) throw new Error(u.searchParams.get('error') ?? 'no code');
          await this.exchangeCode(code);
          const email = await this.fetchProfileEmail();
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<h2>Gmail connected${email ? ` as ${email}` : ''}.</h2><p>You can close this tab.</p>`);
          server.close();
          resolve(email ?? '');
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
          server.close();
          reject(err);
        }
      });
      server.listen(this.oauthPort, '127.0.0.1');
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth consent timed out'));
      }, 10 * 60 * 1000).unref();
    });
    return { url, done };
  }

  private async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({
      code,
      client_id: this.client!.client_id,
      client_secret: this.client!.client_secret,
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
    });
    const res = await fetch(TOKEN_URI, { method: 'POST', body });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    this.token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? this.token?.refresh_token,
      expiry: Date.now() + (data.expires_in - 60) * 1000,
    };
    writeJson(this.tokenFile, this.token);
    fs.chmodSync(this.tokenFile, 0o600);
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.token) throw new Error('Gmail is not authorized; run the consent flow first');
    if (this.token.expiry > Date.now() + 5000) return this.token.access_token;
    if (!this.token.refresh_token) throw new Error('Gmail token expired and no refresh token stored');
    const body = new URLSearchParams({
      client_id: this.client!.client_id,
      client_secret: this.client!.client_secret,
      refresh_token: this.token.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetch(TOKEN_URI, { method: 'POST', body });
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { ...this.token, access_token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000 };
    writeJson(this.tokenFile, this.token);
    return this.token.access_token;
  }

  private async api<T>(pathname: string, init?: RequestInit): Promise<T> {
    const access = await this.ensureAccessToken();
    const res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${access}` },
    });
    if (!res.ok) throw new Error(`Gmail ${pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async fetchProfileEmail(): Promise<string | undefined> {
    try {
      const p = await this.api<{ emailAddress?: string }>('/profile');
      if (p.emailAddress && this.token) {
        this.token.email = p.emailAddress;
        writeJson(this.tokenFile, this.token);
      }
      return p.emailAddress;
    } catch (err) {
      log.warn('could not fetch Gmail profile', { error: String(err) });
      return undefined;
    }
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    const messageId = `<${randomBytes(16).toString('hex')}@autopilot.local>`;
    const raw = buildMime({ ...mail, messageId, from: this.token?.email, fromName: mail.fromName });
    const body: Record<string, unknown> = { raw: base64url(raw) };
    if (mail.threadId) body.threadId = mail.threadId;
    const sent = await this.api<{ id: string; threadId: string }>('/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    log.info('sent mail', { to: mail.to, subject: mail.subject, threadId: sent.threadId });
    return { ...sent, messageIdHeader: messageId };
  }

  /** True when the thread contains a message that is not from the account owner. */
  async threadHasReply(threadId: string): Promise<boolean> {
    const me = (this.token?.email ?? '').toLowerCase();
    const thread = await this.api<{ messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }> }>(
      `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`,
    );
    for (const m of thread.messages ?? []) {
      const from = m.payload?.headers?.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
      if (from && me && !from.toLowerCase().includes(me)) return true;
    }
    return false;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects/names.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildMime(mail: OutgoingMail & { messageId: string; from?: string }): Buffer {
  const boundary = `----=_autopilot_${randomBytes(8).toString('hex')}`;
  const headers: string[] = [];
  if (mail.from) headers.push(`From: ${mail.fromName ? `${encodeHeader(mail.fromName)} <${mail.from}>` : mail.from}`);
  headers.push(`To: ${mail.to}`);
  headers.push(`Subject: ${encodeHeader(mail.subject)}`);
  headers.push(`Message-ID: ${mail.messageId}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push('MIME-Version: 1.0');
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references) headers.push(`References: ${mail.references}`);

  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(mail.text, 'utf8').toString('base64'))].join('\r\n');

  if (!mail.attachments?.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(mail.text, 'utf8').toString('base64'))}\r\n`, 'utf8');
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [`--${boundary}`, textPart];
  for (const a of mail.attachments) {
    parts.push(`--${boundary}`);
    parts.push(
      [
        `Content-Type: ${a.contentType}; name="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${a.filename}"`,
        '',
        wrap76(a.data.toString('base64')),
      ].join('\r\n'),
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`, 'utf8');
}

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, '$1\r\n');
}
