import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApplicationJob, DaemonEvent, JobLogEntry, JobPosting, JobState } from '../protocol.js';
import { readJson, writeJson } from '../util/fs.js';

/**
 * Persistent job store (agent/state/jobs.json). Small enough to rewrite on every change.
 * Emits DaemonEvent objects that the WebSocket layer broadcasts to the extension.
 */
export class JobStore extends EventEmitter {
  private jobs = new Map<string, ApplicationJob>();

  constructor(private readonly file: string) {
    super();
    const saved = readJson<{ jobs: ApplicationJob[] }>(file, { jobs: [] });
    for (const j of saved.jobs) {
      // A daemon restart aborts in-flight tailoring; mark it so the extension can retry.
      if (j.state === 'tailoring' || j.state === 'filling') {
        j.state = 'failed';
        j.error = 'daemon restarted while the job was running';
      }
      this.jobs.set(j.id, j);
    }
  }

  private persist(): void {
    writeJson(this.file, { jobs: [...this.jobs.values()] });
  }

  emitEvent(event: DaemonEvent): void {
    this.emit('event', event);
  }

  list(): ApplicationJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ApplicationJob | undefined {
    return this.jobs.get(id);
  }

  /** Find an open job for the same posting URL so re-detection on reload does not duplicate work. */
  findActiveByUrl(url: string): ApplicationJob | undefined {
    const active: JobState[] = ['queued', 'tailoring', 'ready', 'filling', 'needs_review'];
    for (const j of this.jobs.values()) {
      if (active.includes(j.state) && (j.posting.url === url || j.posting.applyUrl === url)) return j;
    }
    return undefined;
  }

  findSubmittedByUrl(url: string): ApplicationJob | undefined {
    for (const j of this.jobs.values()) {
      if (j.state === 'submitted' && (j.posting.url === url || j.posting.applyUrl === url)) return j;
    }
    return undefined;
  }

  create(posting: JobPosting, tabId?: number): ApplicationJob {
    const now = new Date().toISOString();
    const job: ApplicationJob = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      posting,
      tabId,
      log: [],
    };
    this.jobs.set(job.id, job);
    this.persist();
    this.emitEvent({ type: 'job.updated', job });
    return job;
  }

  update(id: string, patch: Partial<ApplicationJob>): ApplicationJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    this.emitEvent({ type: 'job.updated', job });
    return job;
  }

  log(id: string, message: string, level: JobLogEntry['level'] = 'info'): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const entry: JobLogEntry = { at: new Date().toISOString(), level, message };
    job.log.push(entry);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    job.updatedAt = entry.at;
    this.persist();
    this.emitEvent({ type: 'job.log', jobId: id, entry });
  }

  /** Applications submitted today (for the daily cap). */
  submittedToday(today: string): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.state === 'submitted' && j.submittedAt?.startsWith(today)) n++;
    }
    return n;
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    if (ok) this.persist();
    return ok;
  }
}
