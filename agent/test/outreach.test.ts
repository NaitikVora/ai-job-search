import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMime } from '../src/integrations/gmail.js';
import { deriveTitles, scoreCandidate } from '../src/pipeline/outreach.js';
import { OutreachStore } from '../src/store/outreach.js';

describe('deriveTitles', () => {
  it('produces peer, hiring-manager and recruiter groups from the role', () => {
    const groups = deriveTitles('Senior Machine Learning Engineer - Remote', ['Recruiter']);
    const peers = groups.find((g) => g.kind === 'peer')!.titles;
    const managers = groups.find((g) => g.kind === 'hiring manager')!.titles;
    expect(peers).toContain('Machine Learning Engineer');
    expect(managers).toContain('Head of Machine Learning');
    expect(groups.find((g) => g.kind === 'recruiter')!.titles).toEqual(['Recruiter']);
  });
  it('falls back to the role itself as the department', () => {
    const managers = deriveTitles('Underwater Basket Weaver', [])[1]!.titles;
    expect(managers.some((t) => t.includes('Underwater Basket Weaver'))).toBe(true);
  });
});

describe('scoreCandidate', () => {
  it('ranks same-title peers above unrelated peers and penalises interns', () => {
    const role = 'Machine Learning Engineer';
    const peer = scoreCandidate({ id: '1', title: 'Machine Learning Engineer', has_email: true }, role, 'peer');
    const other = scoreCandidate({ id: '2', title: 'Accountant', has_email: true }, role, 'peer');
    const intern = scoreCandidate({ id: '3', title: 'Machine Learning Intern', has_email: true }, role, 'peer');
    expect(peer).toBeGreaterThan(other);
    expect(peer).toBeGreaterThan(intern);
    expect(peer).toBeLessThanOrEqual(1);
  });
});

describe('OutreachStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists, dedupes contacted people, counts daily sends and mirrors to CSV', () => {
    const store = new OutreachStore(path.join(dir, 'outreach.json'), path.join(dir, 'outreach', 'log.csv'));
    const t = store.add({ company: 'Acme', role: 'ML', slug: 'acme_ml', name: 'Ada L', title: 'ML Engineer', email: 'ada@acme.com', personId: 'p1', relevance: 'peer', relevanceScore: 0.9, status: 'drafted' });
    expect(store.alreadyContacted('ADA@acme.com')).toBe(true);
    expect(store.alreadyContacted(undefined, 'p1')).toBe(true);
    expect(store.alreadyContacted('bob@acme.com')).toBe(false);
    const today = new Date().toISOString();
    store.update(t.id, { status: 'sent', sentAt: today });
    expect(store.sentToday(today.slice(0, 10))).toBe(1);
    expect(store.lastContactAtCompany('acme')).toBe(today);
    const reloaded = new OutreachStore(path.join(dir, 'outreach.json'), path.join(dir, 'outreach', 'log.csv'));
    expect(reloaded.list()).toHaveLength(1);
    const csv = fs.readFileSync(path.join(dir, 'outreach', 'log.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('email');
    expect(csv).toContain('ada@acme.com');
  });
});

describe('buildMime', () => {
  it('builds a multipart message with a PDF attachment and reply headers', () => {
    const raw = buildMime({
      to: 'x@example.com',
      subject: 'Referral for ML Engineer at Acme?',
      text: 'Hi there',
      from: 'me@example.com',
      fromName: 'Ada Lovelace',
      messageId: '<abc@autopilot.local>',
      inReplyTo: '<prev@autopilot.local>',
      attachments: [{ filename: 'Ada_CV.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') }],
    }).toString('utf8');
    expect(raw).toContain('From: Ada Lovelace <me@example.com>');
    expect(raw).toContain('Content-Type: multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename="Ada_CV.pdf"');
    expect(raw).toContain('In-Reply-To: <prev@autopilot.local>');
    expect(raw).toContain(Buffer.from('%PDF-1.4').toString('base64'));
  });
  it('encodes non-ASCII subjects', () => {
    const raw = buildMime({ to: 'x@example.com', subject: 'Søger henvisning', text: 'hej', messageId: '<a@b>' }).toString('utf8');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});
