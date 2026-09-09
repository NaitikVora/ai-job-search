import { stripHtml, toIsoDate } from './dom';

export interface JsonLdJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  deadline?: string;
  datePosted?: string;
  companyUrl?: string;
  applyUrl?: string;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function typeOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const t = (node as { '@type'?: unknown })['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function walk(node: unknown, out: unknown[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  out.push(node);
  const obj = node as Record<string, unknown>;
  if (obj['@graph']) walk(obj['@graph'], out);
}

function nameOf(org: unknown): string | undefined {
  if (!org) return undefined;
  if (typeof org === 'string') return org;
  if (typeof org === 'object' && org && 'name' in org) {
    const n = (org as { name?: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return undefined;
}

function locationOf(loc: unknown): string | undefined {
  if (!loc) return undefined;
  if (typeof loc === 'string') return loc;
  if (typeof loc !== 'object') return undefined;
  const obj = loc as Record<string, unknown>;
  if (typeof obj.name === 'string') return obj.name;
  const addr = obj.address;
  if (typeof addr === 'string') return addr;
  if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (parts.length) return parts.join(', ');
  }
  return undefined;
}

export function parseJobPostingLd(json: unknown): JsonLdJob | null {
  const nodes: unknown[] = [];
  walk(json, nodes);
  const job = nodes.find((n) => typeOf(n).includes('JobPosting'));
  if (!job || typeof job !== 'object') return null;
  const j = job as Record<string, unknown>;
  const org = j.hiringOrganization;
  const loc = asArray(j.jobLocation)[0];
  const title = typeof j.title === 'string' ? j.title : undefined;
  const description = typeof j.description === 'string' ? stripHtml(j.description) : undefined;
  const company = nameOf(org);
  const companyUrl =
    org && typeof org === 'object' && typeof (org as { sameAs?: unknown; url?: unknown }).url === 'string'
      ? ((org as { url: string }).url)
      : org && typeof org === 'object' && typeof (org as { sameAs?: string }).sameAs === 'string'
        ? (org as { sameAs: string }).sameAs
        : undefined;
  const apply =
    typeof j.directApply === 'string'
      ? j.directApply
      : typeof (j as { url?: unknown }).url === 'string'
        ? (j as { url: string }).url
        : undefined;
  return {
    title,
    company,
    location: locationOf(loc) ?? (typeof j.jobLocationType === 'string' ? j.jobLocationType : undefined),
    description,
    deadline: toIsoDate(typeof j.validThrough === 'string' ? j.validThrough : undefined),
    datePosted: toIsoDate(typeof j.datePosted === 'string' ? j.datePosted : undefined),
    companyUrl,
    applyUrl: apply,
  };
}

export function extractJsonLd(doc: Document): JsonLdJob | null {
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  for (const s of scripts) {
    const raw = s.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = parseJobPostingLd(JSON.parse(raw));
      if (parsed?.title || parsed?.description) return parsed;
    } catch {
      /* ignore broken JSON-LD blocks */
    }
  }
  return null;
}
