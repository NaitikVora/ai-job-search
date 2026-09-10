import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { AGENT_VERSION, mergeConfig, saveConfig, toPublicConfig, type AgentConfig, type Paths } from './config.js';
import { runDoctor } from './doctor.js';
import type { GmailClient } from './integrations/gmail.js';
import { logger } from './log.js';
import type { OutreachEngine } from './pipeline/outreach.js';
import type { Runner } from './pipeline/runner.js';
import type { Tracker } from './pipeline/tracker.js';
import type { DaemonEvent, JobPosting, SubmissionReport } from './protocol.js';
import type { JobStore } from './store/jobs.js';
import type { OutreachStore } from './store/outreach.js';

const log = logger('server');

export interface ServerDeps {
  cfg: AgentConfig;
  paths: Paths;
  token: string;
  jobs: JobStore;
  outreachStore: OutreachStore;
  runner: Runner;
  outreach: OutreachEngine;
  tracker: Tracker;
  gmail: GmailClient;
  /** Called when the config changes so long-lived components see the new values. */
  onConfigChange: (cfg: AgentConfig) => void;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const PostingSchema = z.object({
  url: z.string().url(),
  applyUrl: z.string().url().optional(),
  ats: z.string().default('unknown'),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  description: z.string().min(40),
  deadline: z.string().optional(),
  datePosted: z.string().optional(),
  language: z.string().optional(),
  companyDomain: z.string().optional(),
  source: z.enum(['jsonld', 'adapter', 'heuristic', 'manual']).default('heuristic'),
  hasInlineForm: z.boolean().default(false),
  easyApplyOnly: z.boolean().optional(),
});

const FormSchemaZ = z.object({
  url: z.string(),
  ats: z.string(),
  step: z.number().optional(),
  stepLabel: z.string().optional(),
  captchaDetected: z.boolean().default(false),
  submitLabel: z.string().optional(),
  fields: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      label: z.string().default(''),
      context: z.string().optional(),
      name: z.string().optional(),
      placeholder: z.string().optional(),
      required: z.boolean().default(false),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
      currentValue: z.string().optional(),
      maxLength: z.number().optional(),
      accept: z.string().optional(),
      automationId: z.string().optional(),
    }),
  ),
});

const SubmissionSchema = z.object({
  jobId: z.string(),
  submittedAt: z.string(),
  url: z.string(),
  confirmationText: z.string().optional(),
  mode: z.enum(['auto', 'manual']),
});

export function startServer(deps: ServerDeps): http.Server {
  const clients = new Set<WebSocket>();
  const broadcast = (event: DaemonEvent) => {
    const data = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  deps.jobs.on('event', broadcast);
  deps.outreachStore.on('event', broadcast);

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    setCors(res, origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (url.pathname !== '/api/health') authorize(req, deps.token);
      const result = await route(deps, req, url);
      if (result instanceof FileResponse) {
        res.writeHead(200, { 'content-type': result.contentType, 'content-length': result.data.length, 'content-disposition': `inline; filename="${result.filename}"` });
        res.end(result.data);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
      if (status >= 500) log.error('request failed', { url: req.url, message });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !tokenMatches(url.searchParams.get('token') ?? '', deps.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', version: AGENT_VERSION } satisfies DaemonEvent));
      ws.on('close', () => clients.delete(ws));
    });
  });

  server.listen(deps.cfg.port, '127.0.0.1', () => {
    log.info(`listening on http://127.0.0.1:${deps.cfg.port}`);
  });
  return server;
}

class FileResponse {
  constructor(
    public data: Buffer,
    public contentType: string,
    public filename: string,
  ) {}
}

function setCors(res: http.ServerResponse, origin: string | undefined): void {
  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-max-age', '600');
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorize(req: http.IncomingMessage, token: string): void {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!tokenMatches(presented, token)) throw new HttpError(401, 'missing or invalid bearer token; pair the extension with the token printed at daemon startup');
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

async function route(deps: ServerDeps, req: http.IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action, sub] = parts;

  if (resource === 'health' && method === 'GET') return { ok: true, version: AGENT_VERSION };
  if (resource === 'doctor' && method === 'GET') return { checks: await runDoctor(deps.cfg, deps.paths, deps.gmail) };

  if (resource === 'config') {
    if (method === 'GET') return toPublicConfig(deps.cfg, deps.paths);
    if (method === 'PATCH') {
      const patch = await readBody(req);
      const next = mergeConfig(deps.cfg, patch);
      saveConfig(deps.paths, next);
      deps.cfg = next;
      deps.onConfigChange(next);
      const pub = toPublicConfig(next, deps.paths);
      deps.jobs.emitEvent({ type: 'config.updated', config: pub });
      return pub;
    }
  }

  if (resource === 'jobs') {
    if (!id && method === 'GET') return { jobs: deps.jobs.list() };
    if (!id && method === 'POST') {
      const body = (await readBody(req)) as { posting?: unknown; tabId?: number };
      const posting = PostingSchema.parse(body.posting) as JobPosting;
      const { job, created } = deps.runner.enqueue(posting, typeof body.tabId === 'number' ? body.tabId : undefined);
      return { job, created };
    }
    if (id) {
      const job = deps.jobs.get(id);
      if (!job) throw new HttpError(404, 'unknown job');
      if (!action && method === 'GET') return { job };
      if (!action && method === 'DELETE') return { removed: deps.jobs.remove(id) };
      if (action === 'retry' && method === 'POST') return { job: deps.runner.retry(id) };
      if (action === 'map' && method === 'POST') {
        const body = (await readBody(req)) as { form?: unknown };
        const form = FormSchemaZ.parse(body.form);
        return await deps.runner.mapForm(id, form as never);
      }
      if (action === 'review' && method === 'POST') {
        const body = (await readBody(req)) as { reason?: string };
        return { job: deps.runner.markNeedsReview(id, body.reason ?? 'gate blocked auto-submit') };
      }
      if (action === 'submitted' && method === 'POST') {
        const body = SubmissionSchema.parse({ ...((await readBody(req)) as object), jobId: id }) as SubmissionReport;
        return { job: await deps.runner.recordSubmission(body) };
      }
      if (action === 'files' && method === 'GET') {
        const rel = sub === 'cv' ? job.files?.cvPdf : sub === 'cover' ? job.files?.coverPdf : undefined;
        if (!rel) throw new HttpError(404, `no ${sub} file for this job`);
        const abs = path.resolve(deps.paths.repoRoot, rel);
        if (!abs.startsWith(path.resolve(deps.paths.repoRoot) + path.sep) || !fs.existsSync(abs)) throw new HttpError(404, 'file missing');
        return new FileResponse(fs.readFileSync(abs), 'application/pdf', path.basename(abs));
      }
    }
  }

  if (resource === 'tracker' && method === 'GET') return { rows: deps.tracker.list() };

  if (resource === 'outreach') {
    if (!id && method === 'GET') return { targets: deps.outreachStore.list() };
    if (id === 'run' && method === 'POST') {
      const body = z
        .object({
          company: z.string().min(1),
          role: z.string().min(1),
          companyDomain: z.string().optional(),
          postingSummary: z.string().optional(),
          postingUrl: z.string().optional(),
          people: z.number().int().min(1).max(25).optional(),
          jobId: z.string().optional(),
        })
        .parse(await readBody(req));
      return { summary: await deps.outreach.run(body) };
    }
    if (id === 'send-pending' && method === 'POST') return await deps.outreach.sendPending();
    if (id === 'follow-ups' && method === 'POST') return await deps.outreach.processFollowUps();
    if (id && action === 'send' && method === 'POST') return { target: await deps.outreach.sendOne(id) };
    if (id && action === 'skip' && method === 'POST') return { target: deps.outreachStore.update(id, { status: 'skipped' }) };
    if (id && action === 'draft' && method === 'PATCH') {
      const body = z.object({ emailSubject: z.string().optional(), emailBody: z.string().optional(), linkedinNote: z.string().optional() }).parse(await readBody(req));
      return { target: deps.outreachStore.update(id, body) };
    }
  }

  if (resource === 'gmail') {
    if (id === 'status' && method === 'GET') {
      return { hasCredentials: deps.gmail.hasCredentials(), authorized: deps.gmail.isAuthorized(), email: deps.gmail.accountEmail() };
    }
    if (id === 'authorize' && method === 'POST') {
      const { url: authUrl, done } = deps.gmail.authorize();
      done.then((email) => log.info('gmail authorized', { email })).catch((err) => log.warn('gmail auth failed', { err: String(err) }));
      return { url: authUrl };
    }
  }

  throw new HttpError(404, `no route for ${method} ${url.pathname}`);
}
