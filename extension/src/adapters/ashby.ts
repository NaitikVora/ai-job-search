import { firstText, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export const ashbyAdapter: AtsAdapter = {
  kind: 'ashby',
  match(url) {
    return /ashbyhq\.com/i.test(url);
  },
  extract(doc): AdapterExtract {
    const title = firstText(doc, ['h1', '[class*="heading"] h1', '[data-testid="job-title"]']);
    const company =
      firstText(doc, ['a[href="/"]', '[class*="NavBar"] a', 'header a']) ||
      (doc.querySelector('img[alt]') as HTMLImageElement | null)?.alt ||
      '';
    const location = firstText(doc, ['[class*="location"]', '[class*="Overview"] span']);
    const body = doc.querySelector('[class*="JobDescription"], [class*="jobPosting"], article, main');
    const description = stripHtml(body?.innerHTML ?? textOf(body));
    const apply = (doc.querySelector('a[href*="application"], a[href*="apply"]') as HTMLAnchorElement | null)?.href;
    return { title, company, location: location || undefined, description, applyUrl: apply, source: 'adapter' };
  },
  formRoot(doc) {
    return doc.querySelector('form, [class*="ApplicationForm"]');
  },
  hasInlineForm(doc) {
    return Boolean(doc.querySelector('form input, form textarea, [class*="ApplicationForm"]'));
  },
  submitSelector: 'button[type="submit"], button[class*="submit"]',
  confirmationSelectors: ['[class*="Confirmation"], [class*="success"], h1, h2'],
};
