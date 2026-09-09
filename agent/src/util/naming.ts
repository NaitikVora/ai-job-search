/**
 * `<company>_<role>` slug per the Subfolder naming rule in documents/README.md:
 * lowercase, spaces to underscores, every other non [a-z0-9_] character dropped,
 * runs of underscores collapsed, leading/trailing underscores trimmed.
 * Returns '' when nothing survives - callers must stop rather than create files.
 */
export function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function applicationSlug(company: string, role: string): string {
  const c = slugPart(company);
  const r = slugPart(role);
  const joined = [c, r].filter(Boolean).join('_');
  return joined.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/** company_research/<normalized>.json per 04-job-evaluation.md: lowercase, trim, spaces to hyphens. */
export function companyResearchKey(company: string): string {
  return company.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Case-insensitive, whitespace-normalised comparison used for tracker row matching. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Extract a bare registrable-ish domain from a URL or hostname ("https://www.acme.com/x" -> "acme.com"). */
export function toDomain(input: string | undefined): string | undefined {
  if (!input) return undefined;
  let host = input.trim();
  try {
    if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
    host = new URL(host).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return undefined;
  return host;
}

export function todayIso(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
