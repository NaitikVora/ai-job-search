import { firstText, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export const leverAdapter: AtsAdapter = {
  kind: 'lever',
  match(url) {
    return /lever\.co/i.test(url);
  },
  extract(doc): AdapterExtract {
    const title = firstText(doc, ['.posting-headline h2', '.posting-name', 'h2', 'h1']);
    const company =
      firstText(doc, ['.main-header-logo img[alt]', '.main-header-text a']) ||
      (doc.querySelector('.main-header-logo img') as HTMLImageElement | null)?.alt ||
      '';
    const location = firstText(doc, ['.posting-categories .location', '.sort-by-time', '.location']);
    const body = doc.querySelector('.section-wrapper .content, .posting-page .content, [data-qa="job-description"]');
    const description = stripHtml(body?.innerHTML ?? textOf(body));
    const apply = (doc.querySelector('a.postings-btn, a[href$="apply"], a[href*="/apply"]') as HTMLAnchorElement | null)
      ?.href;
    return { title, company, location: location || undefined, description, applyUrl: apply, source: 'adapter' };
  },
  formRoot(doc) {
    return doc.querySelector('#application-form, form.application-form, .application-page form, form');
  },
  hasInlineForm(doc) {
    return /\/apply\/?$/.test(doc.location?.pathname ?? '') || Boolean(doc.querySelector('form.application-form, #application-form'));
  },
  submitSelector: 'button[type="submit"], .postings-btn, input[type="submit"]',
  confirmationSelectors: ['.application-confirmation', '.success-message', 'h3'],
};
