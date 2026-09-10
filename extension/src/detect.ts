import type { AtsKind } from '@protocol';

/** Hostname (and sometimes path) → ATS. Exported for tests. */
export function detectAts(url: string): AtsKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host.endsWith('greenhouse.io') || host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    return 'greenhouse';
  }
  if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) return 'lever';
  if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) return 'ashby';
  if (host.includes('myworkdayjobs.com') || host.endsWith('.workday.com') || host.includes('myworkday.com')) {
    return 'workday';
  }
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (host.includes('icims.com')) return 'icims';
  if (host.endsWith('linkedin.com') && (path.includes('/jobs/') || path.includes('/job/'))) return 'linkedin';
  if (host.includes('indeed.com') && (path.includes('/viewjob') || path.includes('/job/'))) return 'indeed';
  return 'unknown';
}

export function looksLikeJobPage(url: string, doc: Document): boolean {
  const ats = detectAts(url);
  if (ats !== 'unknown') return true;
  if (doc.querySelector('script[type="application/ld+json"]')?.textContent?.includes('JobPosting')) return true;
  const text = `${doc.title} ${url}`.toLowerCase();
  return /\b(job|career|opening|vacancy|position|stilling|ansøg)\b/.test(text);
}
