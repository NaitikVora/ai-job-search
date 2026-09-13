import { adapterFor } from './adapters';
import { textOf, visible } from './dom';
import type { SubmitResult } from './messaging';

const CONFIRM_RE =
  /thank you|thanks for (your )?appl|application (has been )?(received|submitted)|we('ve| have) received|successfully submitted|ansøgning (er )?modtaget/i;
const NEXT_RE = /\b(next|continue|review|save\s*(and|&)\s*continue|proceed)\b/i;
const FINAL_RE = /\b(submit|send|complete|finish)\b.*\b(application|ansøgning)?\b|\bapply now\b/i;

export function findSubmitButton(doc: Document, url: string, forceNext = false): HTMLElement | null {
  const adapter = adapterFor(url);
  const sel =
    forceNext && adapter.nextSelector
      ? `${adapter.nextSelector}, ${adapter.submitSelector}`
      : adapter.nextSelector
        ? `${adapter.nextSelector}, ${adapter.submitSelector}`
        : adapter.submitSelector;
  const nodes = [...doc.querySelectorAll(sel)];
  const visibleNodes = nodes.filter((n): n is HTMLElement => n instanceof HTMLElement && visible(n));
  const visibleBtn = forceNext
    ? visibleNodes.find((n) => actionKind(n) === 'next')
    : visibleNodes.find((n) => actionKind(n) === 'final') ?? visibleNodes.find((n) => actionKind(n) === 'next');
  return visibleBtn ?? (nodes[0] instanceof HTMLElement ? nodes[0] : null);
}

export function actionKind(el: Element): 'next' | 'final' {
  const label = [
    textOf(el),
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('value'),
    el.getAttribute('data-automation-id'),
  ]
    .filter(Boolean)
    .join(' ');
  if (NEXT_RE.test(label) && !FINAL_RE.test(label)) return 'next';
  return 'final';
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

export function clickSubmit(
  doc: Document,
  url: string,
  opts: { force?: boolean; allowFinal?: boolean } = {},
): SubmitResult {
  const already = confirmationText(doc, url);
  if (already) return { submitted: true, confirmationText: already, url };

  const target = findSubmitButton(doc, url, opts.allowFinal === false);
  if (!target) return { submitted: false, url };

  const kind = actionKind(target);
  if (kind === 'final' && opts.allowFinal === false) {
    return { submitted: false, url: doc.location?.href ?? url };
  }
  target.click();
  const confirm = confirmationText(doc, url);
  return {
    submitted: Boolean(confirm) && kind === 'final',
    nextClicked: kind === 'next' || undefined,
    finalClicked: kind === 'final' || undefined,
    confirmationText: confirm,
    url: doc.location?.href ?? url,
  };
}

export async function waitForConfirmation(
  doc: Document,
  url: string,
  timeoutMs = 8000,
): Promise<string | undefined> {
  const immediate = confirmationText(doc, url);
  if (immediate) return immediate;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const value = confirmationText(doc, url);
      if (value) finish(value);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => finish(), timeoutMs);
  });
}

export { CONFIRM_RE, FINAL_RE, NEXT_RE };
