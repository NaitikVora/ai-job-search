export const DEFAULT_SPEEDYAPPLY_FEED =
  'https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md';

export type FeedSection = 'FAANG+' | 'Quant' | 'Other' | string;

export type FeedEntryStatus =
  | 'unseen'
  | 'queued'
  | 'opening'
  | 'loading'
  | 'tailoring'
  | 'filling'
  | 'review'
  | 'submitted'
  | 'skipped'
  | 'failed';

export interface FeedEntry {
  id: string;
  company: string;
  title: string;
  location: string;
  salary?: string;
  url: string;
  companyUrl?: string;
  ageLabel: string;
  /** Numeric sort key. Smaller is newer. */
  ageHours: number;
  section: FeedSection;
  sourceOrder: number;
  status: FeedEntryStatus;
  tabId?: number;
  jobId?: string;
  error?: string;
}

export interface FeedState {
  sourceUrl: string;
  rawUrl: string;
  syncedAt?: string;
  entries: FeedEntry[];
  queue: string[];
  activeId?: string;
  running: boolean;
  lastError?: string;
}

export function emptyFeed(sourceUrl = DEFAULT_SPEEDYAPPLY_FEED): FeedState {
  return {
    sourceUrl,
    rawUrl: githubRawUrl(sourceUrl),
    entries: [],
    queue: [],
    running: false,
  };
}

/** Convert a GitHub blob URL to raw.githubusercontent.com. Other HTTPS URLs pass through. */
export function githubRawUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('feed URL must use HTTPS');
  if (parsed.hostname.toLowerCase() !== 'github.com') return parsed.toString();
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(parsed.pathname);
  if (!match) throw new Error('GitHub feed URL must point to a file using /blob/<branch>/<path>');
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

const SKIP_TITLE =
  /UF Only|Georgia Tech Only|W2 position|Ph\.?D|Mainframe|Starshield|must be a US citizen/i;
const SKIP_COMPANY = /Booz Allen|ActioNet/i;

/** Same deal-breakers as agent/src/pipeline/speedyapply.ts (school lock, clearance, W2 mills). */
export function isEligibleFeedEntry(entry: Pick<FeedEntry, 'title' | 'company'>): boolean {
  return !SKIP_TITLE.test(entry.title) && !SKIP_COMPANY.test(entry.company);
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

/**
 * Parse SpeedyApply's markdown tables. The feed's Age column is relative rather than a stable
 * date, so age is the ordering contract: smallest age first, source order breaks ties.
 */
export function parseSpeedyApplyMarkdown(markdown: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const seen = new Set<string>();
  let section: FeedSection = 'Other';
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

    const companyCell = cells[0];
    const positionCell = cells[1];
    const locationCell = cells[2];
    // FAANG+/Quant currently include Salary; Other currently does not.
    const hasSalary = cells.length >= 6;
    const salaryCell = hasSalary ? cells[3] : undefined;
    const postingCell = cells[hasSalary ? 4 : 3];
    const ageCell = cells[hasSalary ? 5 : 4];
    const extractedUrl = extractHref(postingCell ?? '');
    if (!extractedUrl || !/^https?:\/\//i.test(extractedUrl)) continue;
    // Never put personal application data onto plaintext HTTP. Known legacy links are upgraded
    // before Chrome opens them; sites without HTTPS will fail visibly instead of leaking data.
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
      status: 'unseen',
    });
  }

  return out.sort((a, b) => a.ageHours - b.ageHours || a.sourceOrder - b.sourceOrder);
}

/** Preserve statuses across a feed refresh while replacing changing metadata and age values. */
export function mergeFeedEntries(fresh: FeedEntry[], previous: FeedEntry[]): FeedEntry[] {
  const prior = new Map(previous.map((entry) => [canonicalJobUrl(entry.url), entry]));
  return fresh.map((entry) => {
    const old = prior.get(canonicalJobUrl(entry.url));
    if (!old) return entry;
    return {
      ...entry,
      status: old.status,
      tabId: old.tabId,
      jobId: old.jobId,
      error: old.error,
    };
  });
}

/** Select the next unseen jobs in their already-sorted order without disturbing an active job. */
export function enqueueNextUnseen(feed: FeedState, count: number): FeedState {
  const bounded = Math.max(1, Math.min(50, Math.floor(count || 10)));
  const skippedIds = new Set(
    feed.entries
      .filter((entry) => entry.status === 'unseen' && !isEligibleFeedEntry(entry))
      .map((entry) => entry.id),
  );
  const selected = feed.entries
    .filter((entry) => entry.status === 'unseen' && !skippedIds.has(entry.id))
    .slice(0, bounded);
  const selectedIds = new Set(selected.map((entry) => entry.id));
  return {
    ...feed,
    entries: feed.entries.map((entry) => {
      if (skippedIds.has(entry.id)) {
        return {
          ...entry,
          status: 'skipped',
          error: 'deal-breaker: sponsorship, clearance, school lock, or staffing mill',
        };
      }
      return selectedIds.has(entry.id) ? { ...entry, status: 'queued' } : entry;
    }),
    queue: [...feed.queue, ...selected.map((entry) => entry.id)],
    running: selected.length > 0 || feed.queue.length > 0 || Boolean(feed.activeId),
    lastError:
      selected.length === 0 ? 'no unseen jobs remain; sync the feed or reset an entry' : undefined,
  };
}

/** Stop after the active job and return jobs that have not opened yet to the unseen pool. */
export function stopPendingFeed(feed: FeedState): FeedState {
  const pending = new Set(feed.queue);
  return {
    ...feed,
    entries: feed.entries.map((entry) =>
      pending.has(entry.id) && entry.status === 'queued'
        ? { ...entry, status: 'unseen' }
        : entry,
    ),
    queue: [],
    running: Boolean(feed.activeId),
  };
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
  // The source uses HTML links/images inside markdown cells, but not literal pipes within cells.
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
  // FNV-1a: deterministic, compact, and sufficient for local queue ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `feed-${(hash >>> 0).toString(36)}`;
}
