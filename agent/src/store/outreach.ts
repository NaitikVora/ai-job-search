import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DaemonEvent, OutreachTarget } from '../protocol.js';
import { readJson, writeJson } from '../util/fs.js';
import { toCsvLine } from '../util/csv.js';

const CSV_HEADER = [
  'date',
  'company',
  'role',
  'name',
  'title',
  'email',
  'linkedin_url',
  'status',
  'sent_at',
  'follow_ups_sent',
  'gmail_thread_id',
  'relevance',
];

/**
 * Outreach targets live in agent/state/outreach.json (source of truth) and are mirrored to
 * outreach/outreach_log.csv in the repo so /outreach and humans can read the history.
 */
export class OutreachStore extends EventEmitter {
  private targets = new Map<string, OutreachTarget>();

  constructor(
    private readonly file: string,
    private readonly csvFile: string,
  ) {
    super();
    const saved = readJson<{ targets: OutreachTarget[] }>(file, { targets: [] });
    for (const t of saved.targets) this.targets.set(t.id, t);
  }

  private persist(): void {
    writeJson(this.file, { targets: [...this.targets.values()] });
    this.writeCsvMirror();
  }

  private writeCsvMirror(): void {
    try {
      fs.mkdirSync(path.dirname(this.csvFile), { recursive: true });
      const lines = [toCsvLine(CSV_HEADER)];
      for (const t of this.list()) {
        lines.push(
          toCsvLine([
            t.createdAt.slice(0, 10),
            t.company,
            t.role,
            t.name,
            t.title,
            t.email ?? '',
            t.linkedinUrl ?? '',
            t.status,
            t.sentAt ?? '',
            String(t.followUpsSent),
            t.gmailThreadId ?? '',
            t.relevance,
          ]),
        );
      }
      fs.writeFileSync(this.csvFile, lines.join('\n') + '\n');
    } catch {
      // The CSV is a convenience mirror; never fail the pipeline over it.
    }
  }

  emitEvent(event: DaemonEvent): void {
    this.emit('event', event);
  }

  list(): OutreachTarget[] {
    return [...this.targets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): OutreachTarget | undefined {
    return this.targets.get(id);
  }

  add(target: Omit<OutreachTarget, 'id' | 'createdAt' | 'followUpsSent'>): OutreachTarget {
    const full: OutreachTarget = {
      ...target,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      followUpsSent: 0,
    };
    this.targets.set(full.id, full);
    this.persist();
    this.emitEvent({ type: 'outreach.updated', target: full });
    return full;
  }

  update(id: string, patch: Partial<OutreachTarget>): OutreachTarget {
    const t = this.targets.get(id);
    if (!t) throw new Error(`unknown outreach target ${id}`);
    Object.assign(t, patch);
    this.persist();
    this.emitEvent({ type: 'outreach.updated', target: t });
    return t;
  }

  /** Has this email (or Apollo person) been contacted before, at any company? */
  alreadyContacted(email?: string, personId?: string): boolean {
    for (const t of this.targets.values()) {
      if (t.status === 'skipped' || t.status === 'failed') continue;
      if (email && t.email && t.email.toLowerCase() === email.toLowerCase()) return true;
      if (personId && t.personId === personId) return true;
    }
    return false;
  }

  sentToday(today: string): number {
    let n = 0;
    for (const t of this.targets.values()) {
      if (t.sentAt?.startsWith(today)) n++;
    }
    return n;
  }

  sentToCompany(company: string): OutreachTarget[] {
    const key = company.trim().toLowerCase();
    return [...this.targets.values()].filter((t) => t.company.trim().toLowerCase() === key && t.sentAt);
  }

  lastContactAtCompany(company: string): string | undefined {
    const sent = this.sentToCompany(company)
      .map((t) => t.sentAt!)
      .sort();
    return sent.at(-1);
  }

  dueFollowUps(now: Date): OutreachTarget[] {
    const iso = now.toISOString();
    return [...this.targets.values()].filter(
      (t) => t.status === 'sent' && t.followUpDueAt && t.followUpDueAt <= iso,
    );
  }
}
