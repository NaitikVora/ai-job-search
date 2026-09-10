import { adapterFor } from './adapters';
import { textOf, visible } from './dom';
import type { SubmitResult } from './messaging';

const CONFIRM_RE =
  /thank you|thanks for (your )?appl|application (has been )?(received|submitted)|we('ve| have) received|successfully submitted|ansøgning (er )?modtaget/i;

export function findSubmitButton(doc: Document, url: string, forceNext = false): HTMLElement | null {
  const adapter = adapterFor(url);
  const sel = forceNext && adapter.nextSelector ? `${adapter.nextSelector}, ${adapter.submitSelector}` : adapter.submitSelector;
  const nodes = [...doc.querySelectorAll(sel)];
  const visibleBtn = nodes.find((n): n is HTMLElement => n instanceof HTMLElement && visible(n));
  return visibleBtn ?? (nodes[0] instanceof HTMLElement ? nodes[0] : null);
}

export function confirmationText(doc: Document, url: string): string | undefined {
  const adapter = adapterFor(url);
  for (const sel of adapter.confirmationSelectors) {
    for (const el of doc.querySelectorAll(sel)) {
      const t = textOf(el);
      if (t && CONFIRM_RE.test(t)) return t.slice(0, 280);
    }
  }
  const body = textOf(doc.body).slice(0, 2000);
  const m = CONFIRM_RE.exec(body);
  if (m) return body.slice(Math.max(0, m.index - 40), m.index + 160).trim();
  return undefined;
}

export function looksSubmitted(doc: Document, url: string): boolean {
  return Boolean(confirmationText(doc, url));
}

export function clickSubmit(doc: Document, url: string, opts: { force?: boolean } = {}): SubmitResult {
  const already = confirmationText(doc, url);
  if (already) return { submitted: true, confirmationText: already, url };

  const adapter = adapterFor(url);
  const next = adapter.nextSelector ? doc.querySelector(adapter.nextSelector) : null;
  const submit = findSubmitButton(doc, url);
  const target = (submit ?? next) as HTMLElement | null;
  if (!target) return { submitted: false, url };

  const isNext = next !== null && target === next && target !== submit;
  target.click();
  const confirm = confirmationText(doc, url);
  return {
    submitted: Boolean(confirm) && !isNext,
    nextClicked: isNext || undefined,
    confirmationText: confirm,
    url: doc.location?.href ?? url,
  };
}

export { CONFIRM_RE };
