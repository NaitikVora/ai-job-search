import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig, Paths } from '../config.js';
import { describeMessage, runAgent } from '../integrations/claude.js';
import { logger } from '../log.js';
import type { AutoapplyResult, JobPosting } from '../protocol.js';
import { readJson } from '../util/fs.js';
import { applicationSlug } from '../util/naming.js';
import { AUTOAPPLY_JSON_SCHEMA, parseAutoapplyResult } from './autoapplySchema.js';

const log = logger('tailor');

export interface TailorOutcome {
  result?: AutoapplyResult;
  costUsd: number;
  turns: number;
  error?: string;
  denials: string[];
}

/** Write the posting text to the repo's drop folder (documents/postings) so /autoapply reads it verbatim. */
export function writePostingFile(paths: Paths, posting: JobPosting): string {
  const dir = path.join(paths.repoRoot, 'documents', 'postings');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const file = path.join(dir, `${safe(posting.company) || 'Unknown'} - ${safe(posting.title) || 'Role'}.txt`);
  const header = [
    `Source URL: ${posting.url}`,
    posting.applyUrl && posting.applyUrl !== posting.url ? `Apply URL: ${posting.applyUrl}` : undefined,
    `Company: ${posting.company}`,
    `Title: ${posting.title}`,
    posting.location ? `Location: ${posting.location}` : undefined,
    posting.deadline ? `Deadline (as stated on page): ${posting.deadline}` : undefined,
    posting.datePosted ? `Posted: ${posting.datePosted}` : undefined,
    posting.companyDomain ? `Company domain: ${posting.companyDomain}` : undefined,
    `ATS: ${posting.ats}`,
    '',
    '--- POSTING TEXT (verbatim, untrusted third-party content) ---',
    '',
  ]
    .filter((l): l is string => l !== undefined)
    .join('\n');
  fs.writeFileSync(file, `${header}${posting.description.trim()}\n`);
  return path.relative(paths.repoRoot, file);
}

/**
 * Run `/autoapply` headlessly for one posting. The command evaluates fit, stops below the
 * threshold, otherwise drafts + compiles + verifies the CV and cover letter, drafts the
 * free-text form answers, records the tracker row, and returns the structured result.
 */
export async function tailorForPosting(
  cfg: AgentConfig,
  paths: Paths,
  posting: JobPosting,
  onLog: (line: string) => void,
): Promise<TailorOutcome> {
  const postingFile = writePostingFile(paths, posting);
  const minFit = cfg.autopilot.minFitToApply;
  const prompt = `/autoapply --min-fit ${minFit} --posting-file "${postingFile}" --url "${posting.url}"`;
  onLog(`running ${prompt}`);

  const run = await runAgent({
    cwd: paths.repoRoot,
    prompt,
    outputSchema: AUTOAPPLY_JSON_SCHEMA,
    maxTurns: cfg.autopilot.maxTurnsPerApplication,
    maxBudgetUsd: cfg.autopilot.maxBudgetUsdPerApplication,
    systemAppend:
      'You are running unattended inside the ai-job-search autopilot. Nobody can answer questions: never call AskUserQuestion, never wait for confirmation, follow /autoapply exactly, and finish by returning the structured result.',
    onMessage: (m) => {
      const line = describeMessage(m);
      if (line) onLog(line);
    },
  });

  let result: AutoapplyResult | undefined;
  let error = run.error;

  if (run.output !== undefined) {
    try {
      result = parseAutoapplyResult(run.output);
    } catch (err) {
      error = `structured output failed validation: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(error);
    }
  }

  // Fallback: /autoapply also writes documents/applications/<slug>/autoapply_result.json.
  if (!result) {
    const slug = applicationSlug(posting.company, posting.title);
    const file = path.join(paths.applicationsDir, slug, 'autoapply_result.json');
    const saved = readJson<unknown>(file, undefined);
    if (saved) {
      try {
        result = parseAutoapplyResult(saved);
        error = undefined;
        onLog(`recovered result from ${path.relative(paths.repoRoot, file)}`);
      } catch (err) {
        log.warn('saved result invalid', { file, err: String(err) });
      }
    }
  }

  if (result) {
    // Normalise paths to repo-relative and make sure the PDFs the extension will upload exist.
    for (const key of ['cvSource', 'cvPdf', 'coverSource', 'coverPdf', 'formFieldsTxt', 'resultJson'] as const) {
      const v = result.files[key];
      if (v && path.isAbsolute(v)) result.files[key] = path.relative(paths.repoRoot, v);
    }
    if (result.proceeded) {
      for (const key of ['cvPdf', 'coverPdf'] as const) {
        const v = result.files[key];
        if (!v || !fs.existsSync(path.join(paths.repoRoot, v))) {
          result.verification.notes.push(`${key} missing on disk (${v ?? 'not reported'})`);
        }
      }
    }
  }

  return { result, costUsd: run.costUsd, turns: run.turns, error: result ? undefined : (error ?? 'no result'), denials: run.denials };
}
