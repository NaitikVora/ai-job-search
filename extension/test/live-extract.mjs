/**
 * Optional live check: fetch public ATS listing pages and confirm the hostname
 * router + extractor produce something usable. Not part of `npm test` (network).
 */
import { JSDOM } from 'jsdom';
import { detectAts } from '../src/detect.ts';
import { extractPosting } from '../src/extract.ts';

const URLS = [
  'https://job-boards.greenhouse.io/figma/jobs/5426468004',
  'https://jobs.lever.co/leverdemo/120b5976-ee4e-4dc5-b31b-2b1ca124460c',
  'https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff',
];

const headers = { 'user-agent': 'Mozilla/5.0 (compatible; ai-job-search-autopilot-test/0.1)' };

for (const url of URLS) {
  const ats = detectAts(url);
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const html = await res.text();
    const dom = new JSDOM(html, { url: res.url });
    const posting = extractPosting(dom.window.document, res.url);
    const ok = Boolean(posting?.title && posting?.company && (posting.description?.length ?? 0) >= 40);
    console.log(
      JSON.stringify({
        requested: url,
        final: res.url,
        status: res.status,
        ats,
        extracted: ok,
        title: posting?.title,
        company: posting?.company,
        source: posting?.source,
        descLen: posting?.description?.length ?? 0,
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ requested: url, ats, error: err instanceof Error ? err.message : String(err) }));
  }
}
