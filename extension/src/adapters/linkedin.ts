import { firstText, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export function isEasyApply(doc: Document): boolean {
  const btn = doc.querySelector('.jobs-apply-button, button.jobs-apply-button--top-card, [aria-label*="Easy Apply" i]');
  const label = `${btn?.getAttribute('aria-label') ?? ''} ${textOf(btn)}`.toLowerCase();
  return /easy apply/.test(label);
}

export const linkedinAdapter: AtsAdapter = {
  kind: 'linkedin',
  match(url) {
    return /linkedin\.com\/jobs/i.test(url);
  },
  extract(doc): AdapterExtract {
    const title = firstText(doc, [
      '.job-details-jobs-unified-top-card__job-title',
      'h1.t-24',
      'h1',
    ]);
    const company = firstText(doc, [
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      'a.topcard__org-name-link',
    ]);
    const location = firstText(doc, [
      '.job-details-jobs-unified-top-card__bullet',
      '.jobs-unified-top-card__bullet',
      '.topcard__flavor--bullet',
    ]);
    const body = doc.querySelector('#job-details, .jobs-description, .jobs-box__html-content, .description__text');
    const description = stripHtml(body?.innerHTML ?? textOf(body));
    const apply = (doc.querySelector('a.jobs-apply-button, a[data-control-name="jobdetails_topcard_inapply"]') as HTMLAnchorElement | null)
      ?.href;
    return { title, company, location: location || undefined, description, applyUrl: apply, source: 'adapter' };
  },
  formRoot(doc) {
    return doc.querySelector('.jobs-easy-apply-modal, .jobs-easy-apply-content, form');
  },
  hasInlineForm(doc) {
    return Boolean(doc.querySelector('.jobs-easy-apply-modal, .jobs-easy-apply-content'));
  },
  easyApplyOnly(doc) {
    return isEasyApply(doc) && !this.extract(doc).applyUrl;
  },
  submitSelector: 'button[aria-label*="Submit application" i], button[aria-label*="Submit" i]',
  nextSelector: 'button[aria-label*="Continue" i], button[aria-label*="Next" i], button[aria-label*="Review" i]',
  confirmationSelectors: ['.artdeco-inline-feedback--success', '.jpac-modal-header', 'h2'],
};
