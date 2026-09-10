import type { AtsKind, JobPosting } from '@protocol';

export interface AdapterExtract {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  deadline?: string;
  datePosted?: string;
  applyUrl?: string;
  companyDomain?: string;
  source?: JobPosting['source'];
}

export interface AtsAdapter {
  kind: AtsKind;
  match(url: string): boolean;
  extract(doc: Document, url: string): AdapterExtract;
  /** Root of the application form, if this page hosts one. */
  formRoot(doc: Document): Element | null;
  hasInlineForm(doc: Document): boolean;
  easyApplyOnly?(doc: Document): boolean;
  submitSelector: string;
  nextSelector?: string;
  confirmationSelectors: string[];
}
