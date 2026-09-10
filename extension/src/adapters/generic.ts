import { captchaPresent, firstText, metaContent, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export const genericAdapter: AtsAdapter = {
  kind: 'unknown',
  match() {
    return true;
  },
  extract(doc, url) {
    const title =
      metaContent(doc, ['og:title', 'twitter:title']) ||
      firstText(doc, ['h1', '[itemprop="title"]', '.job-title', '.jobTitle']) ||
      doc.title.replace(/\s+[|\-–].*$/, '').trim();
    const company =
      metaContent(doc, ['og:site_name', 'twitter:site']) ||
      firstText(doc, ['[itemprop="hiringOrganization"]', '.company-name', '.employer', '[data-company]']);
    const location = firstText(doc, ['[itemprop="jobLocation"]', '.job-location', '.location']);
    const main =
      doc.querySelector('article, [role="main"], main, .job-description, #job-description, .description') ??
      doc.body;
    const description = stripHtml(main?.innerHTML ?? textOf(main));
    const apply = (doc.querySelector('a[href*="apply"], a[href*="application"], a.apply') as HTMLAnchorElement | null)?.href;
    return {
      title,
      company,
      location: location || undefined,
      description,
      applyUrl: apply && apply !== url ? apply : undefined,
      source: 'heuristic',
    };
  },
  formRoot(doc) {
    return (
      doc.querySelector('form#application-form, form[action*="apply"], form[action*="application"], form') ??
      (captchaPresent(doc) ? doc.body : null)
    );
  },
  hasInlineForm(doc) {
    return Boolean(this.formRoot(doc)?.querySelector('input, textarea, select'));
  },
  submitSelector:
    'button[type="submit"], input[type="submit"], button.submit, [data-qa="submit"], button[aria-label*="Submit" i]',
  nextSelector: 'button[type="button"].next, button[data-qa="next"], button[aria-label*="Next" i]',
  confirmationSelectors: [
    '.confirmation',
    '[data-qa="confirmation"]',
    '.application-confirmation',
    'h1, h2, p',
  ],
};
