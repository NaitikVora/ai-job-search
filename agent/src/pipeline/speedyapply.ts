/** SpeedyApply NEW_GRAD_USA.md parser. Discovery source for Cursor-driven apply. */

import type { AtsKind, JobPosting } from '../protocol.js';
import { toDomain } from '../util/naming.js';

export const DEFAULT_SPEEDYAPPLY_FEED =
  'https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md';

export interface SpeedyApplyJob {
  id: string;
  company: string;
  title: string;
  location: string;
  salary?: string;
  url: string;
  companyUrl?: string;
  ageLabel: string;
  ageHours: number;
  section: string;
  sourceOrder: number;
}

const SKIP_TITLE =
  /UF Only|Georgia Tech Only|W2 position|Ph\.?D|Mainframe|Starshield|must be a US citizen/i;
const SKIP_COMPANY = /Booz Allen|ActioNet/i;

export function githubRawUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('feed URL must use HTTPS');
  if (parsed.hostname.toLowerCase() !== 'github.com') return parsed.toString();
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(parsed.pathname);
  if (!match) throw new Error('GitHub feed URL must point to a file using /blob/<branch>/<path>');
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

export function parseAgeHours(label: string): number {
  const value = label.trim().toLowerCase();
  if (value === 'today' || value === 'new') return 0;
  const match = /^<?\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|d|day|days|w|wk|wks|mo|mos|month|months|y|yr|yrs)$/.exec(
    value,
  );
  if (!match) return Number.POSITIVE_INFINITY;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'h' || unit === 'hr' || unit === 'hrs') return amount;
  if (unit === 'd' || unit === 'day' || unit === 'days') return amount * 24;
  if (unit === 'w' || unit === 'wk' || unit === 'wks') return amount * 24 * 7;
  if (unit === 'mo' || unit === 'mos' || unit === 'month' || unit === 'months') return amount * 24 * 30;
  return amount * 24 * 365;
}

export function parseSpeedyApplyMarkdown(markdown: string): SpeedyApplyJob[] {
  const out: SpeedyApplyJob[] = [];
  const seen = new Set<string>();
  let section = 'Other';
  let sourceOrder = 0;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = stripMarkup(heading[1] ?? '');
      if (/^faang\+$/i.test(name)) section = 'FAANG+';
      else if (/^quant$/i.test(name)) section = 'Quant';
      else if (/^other$/i.test(name)) section = 'Other';
      continue;
    }
    if (!line.startsWith('|') || /^\|\s*-+/.test(line) || /\|\s*Company\s*\|/i.test(line)) continue;
    const cells = splitTableRow(line);
    if (cells.length < 5) continue;

    const hasSalary = cells.length >= 6;
    const companyCell = cells[0];
    const positionCell = cells[1];
    const locationCell = cells[2];
    const salaryCell = hasSalary ? cells[3] : undefined;
    const postingCell = cells[hasSalary ? 4 : 3];
    const ageCell = cells[hasSalary ? 5 : 4];
    const extractedUrl = extractHref(postingCell ?? '');
    if (!extractedUrl || !/^https?:\/\//i.test(extractedUrl)) continue;
    const url = extractedUrl.replace(/^http:\/\//i, 'https://');
    const normalizedUrl = canonicalJobUrl(url);
    if (seen.has(normalizedUrl)) continue;

    const company = stripMarkup(companyCell ?? '');
    const title = stripMarkup(positionCell ?? '');
    const location = stripMarkup(locationCell ?? '');
    const ageLabel = stripMarkup(ageCell ?? '');
    if (!company || !title || !ageLabel) continue;

    seen.add(normalizedUrl);
    out.push({
      id: stableId(normalizedUrl),
      company,
      title,
      location,
      salary: stripMarkup(salaryCell ?? '') || undefined,
      url,
      companyUrl: extractHref(companyCell ?? '') || undefined,
      ageLabel,
      ageHours: parseAgeHours(ageLabel),
      section,
      sourceOrder: sourceOrder++,
    });
  }

  return out.sort((a, b) => a.ageHours - b.ageHours || a.sourceOrder - b.sourceOrder);
}

/** Hard skips: citizenship, clearance, school lock, staffing mills. */
export function isEligibleSpeedyApplyJob(job: Pick<SpeedyApplyJob, 'title' | 'company'>): boolean {
  return !SKIP_TITLE.test(job.title) && !SKIP_COMPANY.test(job.company);
}

export function ineligibleReason(job: Pick<SpeedyApplyJob, 'title' | 'company'>): string | undefined {
  if (SKIP_TITLE.test(job.title)) return `title matches a deal-breaker: ${job.title}`;
  if (SKIP_COMPANY.test(job.company)) return `company matches a deal-breaker: ${job.company}`;
  return undefined;
}

export function guessAts(url: string): AtsKind {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('greenhouse')) return 'greenhouse';
    if (host.includes('lever.co')) return 'lever';
    if (host.includes('ashbyhq.com')) return 'ashby';
    if (host.includes('myworkdayjobs.com')) return 'workday';
    if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (host.includes('icims.com')) return 'icims';
    if (host.includes('linkedin.com')) return 'linkedin';
    if (host.includes('indeed.com')) return 'indeed';
  } catch {
    /* ignore */
  }
  return 'unknown';
}

/** Metadata-only posting the Cursor /autoapply path expands from the apply URL. */
export function speedyJobToPosting(job: SpeedyApplyJob): JobPosting {
  const lines = [
    `${job.company} is hiring for ${job.title}.`,
    job.location ? `Location: ${job.location}.` : undefined,
    job.salary ? `Salary listed on SpeedyApply: ${job.salary}.` : undefined,
    `Apply URL: ${job.url}`,
    '---',
    'Full posting text is not in the SpeedyApply table. Fetch the Apply URL before scoring.',
  ].filter((line): line is string => Boolean(line));
  return {
    url: job.url,
    applyUrl: job.url,
    ats: guessAts(job.url),
    title: job.title,
    company: job.company,
    location: job.location || undefined,
    description: lines.join('\n'),
    companyDomain: toDomain(job.companyUrl),
    source: 'manual',
    hasInlineForm: false,
  };
}

export async function fetchSpeedyApplyFeed(
  sourceUrl = DEFAULT_SPEEDYAPPLY_FEED,
): Promise<SpeedyApplyJob[]> {
  const rawUrl = githubRawUrl(sourceUrl);
  const res = await fetch(rawUrl, {
    headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1' },
  });
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
  const markdown = await res.text();
  if (markdown.length > 2_000_000) throw new Error('feed is larger than the 2 MB safety limit');
  const parsed = parseSpeedyApplyMarkdown(markdown);
  if (parsed.length === 0) throw new Error('no SpeedyApply job rows found in the feed');
  return parsed;
}

export function canonicalJobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['source', 'ref', 'referrer'].includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function extractHref(value: string): string | undefined {
  const html = /<a\s+[^>]*href=["']([^"']+)["']/i.exec(value)?.[1];
  if (html) return decodeEntities(html);
  const markdown = /\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(value)?.[1];
  return markdown ? decodeEntities(markdown) : undefined;
}

function stripMarkup(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, ' / ')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/!\[[^\]]*]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `feed-${(hash >>> 0).toString(36)}`;
}
