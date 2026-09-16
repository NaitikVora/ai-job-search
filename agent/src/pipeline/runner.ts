import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig, Paths } from '../config.js';
import type { Llm } from '../integrations/llm.js';
import { logger } from '../log.js';
import type { ApplicationJob, FormSchema, JobPosting, MapFieldsResponse, SubmissionReport } from '../protocol.js';
import type { JobStore } from '../store/jobs.js';
import { applicationSlug, todayIso } from '../util/naming.js';
import { decideGate } from './gates.js';
import { mapFields } from './mapFields.js';
import type { OutreachEngine } from './outreach.js';
import { loadProfileContext, profileLooksUnpopulated } from './profile.js';
import { tailorForPosting } from './tailor.js';
import type { Tracker } from './tracker.js';

const log = logger('runner');

/**
 * Orchestrates one application from detection to submission. Tailoring runs one job at a
 * time (each /autoapply run is minutes of agent work); everything else is request/response.
 */
export class Runner {
  private queue: string[] = [];
  private running = false;

  constructor(
    public cfg: AgentConfig,
    private readonly paths: Paths,
    private readonly jobs: JobStore,
    private readonly tracker: Tracker,
    private readonly llm: Llm,
    private readonly outreach: OutreachEngine,
  ) {}

  /** Idempotent: re-detecting the same URL returns the existing job instead of a duplicate. */
  enqueue(posting: JobPosting, tabId?: number): { job: ApplicationJob; created: boolean } {
    const active = this.jobs.findActiveByUrl(posting.url);
    if (active) {
      if (tabId !== undefined && active.tabId !== tabId) this.jobs.update(active.id, { tabId });
      return { job: active, created: false };
    }
    const submitted = this.jobs.findSubmittedByUrl(posting.url);
    if (submitted) return { job: submitted, created: false };

    const job = this.jobs.create(posting, tabId);
    this.jobs.log(job.id, `queued ${posting.company} - ${posting.title} (${posting.ats})`);
    this.queue.push(job.id);
    void this.drain();
    return { job, created: true };
  }

  retry(jobId: string): ApplicationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    if (job.state === 'tailoring') return job;
    this.jobs.update(jobId, { state: 'queued', error: undefined, gate: undefined });
    this.jobs.log(jobId, 'retry requested');
    this.queue.push(jobId);
    void this.drain();
    return this.jobs.get(jobId)!;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          await this.process(id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('job failed', { id, message });
          if (this.jobs.get(id)) {
            this.jobs.update(id, { state: 'failed', error: message });
            this.jobs.log(id, message, 'error');
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'queued') return;
    const { posting } = job;

    if (!this.cfg.autopilot.enabled) {
      this.skip(id, 'autopilot is disabled in agent/config.json');
      return;
    }
    if (this.tracker.hasAnyRow(posting.company, posting.title)) {
      this.skip(id, `already in job_search_tracker.csv: ${posting.company} / ${posting.title}`);
      return;
    }
    if (this.jobs.submittedToday(todayIso()) >= this.cfg.autopilot.maxApplicationsPerDay) {
      this.skip(id, `daily cap of ${this.cfg.autopilot.maxApplicationsPerDay} applications reached`);
      return;
    }
    const profile = loadProfileContext(this.paths);
    if (profileLooksUnpopulated(profile)) {
      this.skip(id, 'candidate profile is unpopulated: run /setup first');
      return;
    }

    this.jobs.update(id, { state: 'tailoring' });
    this.jobs.log(id, `evaluating fit and drafting documents (threshold ${this.cfg.autopilot.minFitToApply})`);

    const outcome = await tailorForPosting(this.cfg, this.paths, posting, (line) => this.jobs.log(id, line));
    const cost = outcome.costUsd;
    if (outcome.denials.length) this.jobs.log(id, `policy denied ${outcome.denials.length} tool call(s)`, 'warn');

    if (!outcome.result) {
      this.jobs.update(id, { state: 'failed', error: outcome.error ?? 'tailoring failed', costUsd: cost });
      this.jobs.log(id, outcome.error ?? 'tailoring failed', 'error');
      return;
    }
    const result = outcome.result;
    const fitLine = `fit ${result.fit.overall}/100 (${result.fit.verdict}); location ${result.fit.locationGate}, language ${result.fit.languageGate}`;
    this.jobs.log(id, fitLine);

    if (!result.proceeded) {
      this.jobs.update(id, { state: 'skipped', result, fit: result.fit, costUsd: cost, error: result.skipReason });
      this.jobs.log(id, `skipped: ${result.skipReason ?? 'below threshold'}`);
      return;
    }

    for (const note of result.verification.notes) this.jobs.log(id, `verification: ${note}`, 'warn');
    this.jobs.update(id, {
      state: 'ready',
      result,
      fit: result.fit,
      files: result.files,
      formAnswers: result.formAnswers,
      costUsd: cost,
    });
    this.jobs.log(id, `documents ready: ${result.files.cvPdf ?? '?'} / ${result.files.coverPdf ?? '?'}`);
  }

  private skip(id: string, reason: string): void {
    this.jobs.update(id, { state: 'skipped', error: reason });
    this.jobs.log(id, `skipped: ${reason}`);
  }

  /** Map one form (or one step of a multi-step form) to answers and decide the gate. */
  async mapForm(jobId: string, form: FormSchema): Promise<MapFieldsResponse> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('unknown job');
    if (!['ready', 'filling', 'needs_review'].includes(job.state)) {
      throw new Error(`job is ${job.state}; documents are not ready`);
    }
    this.jobs.update(jobId, { state: 'filling' });
    this.jobs.log(jobId, `mapping ${form.fields.length} field(s) on ${form.ats}${form.step ? ` step ${form.step}` : ''}`);
    const profile = loadProfileContext(this.paths);
    const answers = await mapFields(this.llm, { job, form, profile });
    const gate = decideGate({
      cfg: this.cfg,
      form,
      answers,
      fit: job.fit?.overall,
      submittedToday: this.jobs.submittedToday(todayIso()),
      profilePopulated: !profileLooksUnpopulated(profile),
    });
    const byId = new Map(form.fields.map((f) => [f.id, f]));
    const unresolved = answers
      .filter((a) => a.answer.type === 'skip')
      .map((a) => {
        const f = byId.get(a.fieldId);
        return { fieldId: a.fieldId, label: f?.label ?? a.fieldId, required: f?.required ?? false, reason: (a.answer as { reason: string }).reason };
      });
    this.jobs.update(jobId, { gate });
    this.jobs.log(
      jobId,
      gate.autoSubmit ? 'gate: auto-submit allowed' : `gate: review required (${gate.reasons.join('; ')})`,
      gate.autoSubmit ? 'info' : 'warn',
    );
    return { answers, unresolved, gate };
  }

  markNeedsReview(jobId: string, reason: string): ApplicationJob {
    const job = this.jobs.update(jobId, { state: 'needs_review' });
    this.jobs.log(jobId, `waiting for human review: ${reason}`, 'warn');
    return job;
  }

  /** The form was submitted (automatically or by the human). Update the tracker, archive, start outreach. */
  async recordSubmission(report: SubmissionReport): Promise<ApplicationJob> {
    const job = this.jobs.get(report.jobId);
    if (!job) throw new Error('unknown job');
    if (job.state === 'submitted') return job;

    const company = job.result?.company ?? job.posting.company;
    const role = job.result?.role ?? job.posting.title;
    const slug = job.result?.slug || applicationSlug(company, role);

    const tracked = this.tracker.markApplied({
      company,
      role,
      submittedAt: new Date(report.submittedAt),
      note: `applied ${report.submittedAt.slice(0, 10)} via autopilot (${report.mode})`,
      fitRating: job.fit?.overall,
      cvFile: job.files?.cvSource,
      coverLetterFile: job.files?.coverSource,
      source: job.posting.url,
      deadline: job.result?.deadline ?? job.posting.deadline ?? '',
      channel: job.posting.ats === 'linkedin' || job.posting.ats === 'indeed' ? 'portal' : 'online',
    });
    this.jobs.log(report.jobId, `tracker row ${tracked.action}: ${company} / ${role} -> applied`);

    this.archive(job, slug, report);

    const updated = this.jobs.update(report.jobId, {
      state: 'submitted',
      submittedAt: report.submittedAt,
      submissionUrl: report.url,
    });

    if (this.cfg.outreach.mode !== 'off') {
      this.jobs.log(report.jobId, `starting referral outreach (${this.cfg.outreach.mode})`);
      void this.outreach
        .run(this.outreach.requestFromJob(updated))
        .then((s) => this.jobs.log(report.jobId, `outreach: found ${s.found}, enriched ${s.enriched}, drafted ${s.drafted}, sent ${s.sent}, credits ${s.creditsSpent}${s.notes.length ? ` (${s.notes.join('; ')})` : ''}`))
        .catch((err) => this.jobs.log(report.jobId, `outreach failed: ${err instanceof Error ? err.message : String(err)}`, 'error'));
    }
    return updated;
  }

  /** Mirror what /outcome archives: the submitted sources + PDFs + a submission record, in documents/applications/<slug>/. */
  private archive(job: ApplicationJob, slug: string, report: SubmissionReport): void {
    if (!slug) return;
    const dir = path.join(this.paths.applicationsDir, slug);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const copies: Array<[string | undefined, string]> = [
        [job.files?.cvSource, `cv_draft${extOf(job.files?.cvSource) ?? '.tex'}`],
        [job.files?.coverSource, `cover_letter${extOf(job.files?.coverSource) ?? '.tex'}`],
        [job.files?.cvPdf, 'cv_draft.pdf'],
        [job.files?.coverPdf, 'cover_letter.pdf'],
      ];
      for (const [src, name] of copies) {
        if (!src) continue;
        const abs = path.join(this.paths.repoRoot, src);
        if (fs.existsSync(abs)) fs.copyFileSync(abs, path.join(dir, name));
      }
      fs.writeFileSync(
        path.join(dir, 'submission.json'),
        JSON.stringify(
          {
            submittedAt: report.submittedAt,
            url: report.url,
            mode: report.mode,
            confirmationText: report.confirmationText,
            postingUrl: job.posting.url,
            ats: job.posting.ats,
            fit: job.fit,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (err) {
      log.warn('archive failed', { dir, err: String(err) });
    }
  }
}

function extOf(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const e = path.extname(file);
  return e || undefined;
}
