import { firstText, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export const workdayAdapter: AtsAdapter = {
  kind: 'workday',
  match(url) {
    return /myworkdayjobs\.com|myworkday\.com|workday\.com/i.test(url);
  },
  extract(doc): AdapterExtract {
    const title = firstText(doc, [
      '[data-automation-id="jobPostingHeader"]',
      '[data-automation-id="jobTitle"]',
      'h2[data-automation-id]',
      'h1',
    ]);
    const company = firstText(doc, ['[data-automation-id="company"]', 'title']).replace(/\s+[-|:].*$/, '');
    const location = firstText(doc, [
      '[data-automation-id="locations"]',
      '[data-automation-id="jobLocation"]',
      'dd[data-automation-id]',
    ]);
    const body = doc.querySelector('[data-automation-id="jobPostingDescription"], [data-automation-id="job-posting-details"]');
    const description = stripHtml(body?.innerHTML ?? textOf(body));
    return { title, company, location: location || undefined, description, source: 'adapter' };
  },
  formRoot(doc) {
    return doc.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="applyForm"], form, main');
  },
  hasInlineForm(doc) {
    return Boolean(doc.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="formField-"]'));
  },
  submitSelector:
    '[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"], button[data-automation-id*="submit" i]',
  nextSelector: '[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]',
  confirmationSelectors: ['[data-automation-id="successMessage"], [data-automation-id="confirmationMessage"], h1, h2'],
};
