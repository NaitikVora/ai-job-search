import { firstText, stripHtml, textOf } from '../dom';
import type { AdapterExtract, AtsAdapter } from './types';

export const greenhouseAdapter: AtsAdapter = {
  kind: 'greenhouse',
  match(url) {
    return /greenhouse\.io/i.test(url);
  },
  extract(doc, pageUrl): AdapterExtract {
    const title = firstText(doc, [
      '.job__title h1',
      'h1.section-header',
      '.app-title',
      '#header h1',
      '[data-testid="job-title"]',
      'h1.app-title',
      'h1',
    ]);
    const fromTitle = /(?:Job Application for .+ at |at )([^|\-–]+)$/i.exec(doc.title ?? '');
    const fromPath = /greenhouse\.io\/([^/]+)\/jobs/i.exec(pageUrl);
    const company = (
      firstText(doc, [
        '.company-name',
        '#header .company-name',
        '.job__header .company',
        '[data-testid="company-name"]',
      ]) ||
      fromTitle?.[1] ||
      (fromPath?.[1] ? fromPath[1].replace(/-/g, ' ') : '')
    )
      .replace(/\s+Job Application$/i, '')
      .replace(/^Job Application for .+ at /i, '')
      .trim();
    const location = firstText(doc, ['.location', '#header .location', '.job__location', '[data-testid="job-location"]']);
    const body =
      doc.querySelector('#content, #app_body, .job__description, [data-testid="job-posting"] .job-post, .content') ??
      doc.querySelector('.job-post');
    const description = stripHtml(body?.innerHTML ?? textOf(body));
    const apply = (doc.querySelector('a#apply_button, a[href*="#app"], a[href*="application"]') as HTMLAnchorElement | null)
      ?.href;
    return { title, company, location: location || undefined, description, applyUrl: apply, source: 'adapter' };
  },
  formRoot(doc) {
    return (
      doc.querySelector('#application-form, form#application_form, #application, form[id*="application"]') ??
      doc.querySelector('#app_body form, form')
    );
  },
  hasInlineForm(doc) {
    return Boolean(doc.querySelector('#application, #application-form, form#application_form, input[name="first_name"]'));
  },
  submitSelector: '#submit_app, input#submit_app, button[type="submit"], input[type="submit"]',
  confirmationSelectors: ['.accessibility', '#main_fields', 'h1', '.flash'],
};
