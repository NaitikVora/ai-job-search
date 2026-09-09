import type { JobPosting } from '@protocol';
import { adapterFor } from './adapters';
import { detectAts } from './detect';
import { companyDomainFrom, guessLanguage } from './dom';
import { extractJsonLd } from './jsonld';

function pick(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Build a JobPosting from the current document. JSON-LD wins, then the ATS adapter,
 * then generic heuristics. Returns null when title/company/description cannot be assembled.
 */
export function extractPosting(doc: Document, url: string): JobPosting | null {
  const ats = detectAts(url);
  const adapter = adapterFor(url);
  const jsonld = extractJsonLd(doc);
  const adapted = adapter.extract(doc, url);

  const title = pick(jsonld?.title, adapted.title);
  const company = pick(jsonld?.company, adapted.company);
  let description = pick(jsonld?.description, adapted.description) ?? '';
  if (description.length < 40) return null;
  if (!title || !company) return null;

  const applyUrl = pick(adapted.applyUrl, jsonld?.applyUrl);
  const source: JobPosting['source'] = jsonld?.title ? 'jsonld' : adapted.source ?? 'heuristic';
  const companyDomain = companyDomainFrom(jsonld?.companyUrl) ?? adapted.companyDomain;

  return {
    url,
    applyUrl: applyUrl && applyUrl !== url ? applyUrl : undefined,
    ats,
    title,
    company,
    location: pick(jsonld?.location, adapted.location),
    description,
    deadline: pick(jsonld?.deadline, adapted.deadline),
    datePosted: pick(jsonld?.datePosted, adapted.datePosted),
    language: guessLanguage(doc, description),
    companyDomain,
    source,
    hasInlineForm: adapter.hasInlineForm(doc),
    easyApplyOnly: adapter.easyApplyOnly?.(doc) ?? false,
  };
}
