/** Shared DOM helpers used by extract, scan, and fill. Safe to call from jsdom. */

export function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

export function textOf(el: Element | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function firstText(root: ParentNode, selectors: string[]): string {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const t = textOf(el);
    if (t) return t;
  }
  return '';
}

export function metaContent(doc: Document, names: string[]): string {
  for (const name of names) {
    const el =
      doc.querySelector(`meta[property="${name}"]`) ??
      doc.querySelector(`meta[name="${name}"]`) ??
      doc.querySelector(`meta[itemprop="${name}"]`);
    const c = el?.getAttribute('content')?.trim();
    if (c) return c;
  }
  return '';
}

export function closestLabel(el: Element): string {
  if (el instanceof HTMLElement) {
    const aria = el.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const bits = labelled
        .split(/\s+/)
        .map((id) => textOf(el.ownerDocument.getElementById(id)))
        .filter(Boolean);
      if (bits.length) return bits.join(' ');
    }
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels && el.labels.length) return textOf(el.labels[0]);
    if (el.id) {
      const byFor = el.ownerDocument.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (byFor) return textOf(byFor);
    }
  }
  const wrapping = el.closest('label');
  if (wrapping) return textOf(wrapping);
  const prev = previousLabelish(el);
  if (prev) return prev;
  return (el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '').trim();
}

function previousLabelish(el: Element): string {
  let node: Element | null = el.previousElementSibling;
  for (let i = 0; i < 4 && node; i++, node = node.previousElementSibling) {
    if (node.matches('label, legend, span, p, div, strong, h1, h2, h3, h4')) {
      const t = textOf(node);
      if (t && t.length < 160) return t;
    }
  }
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector(':scope > legend');
    if (legend) return textOf(legend);
  }
  return '';
}

export function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(id);
  return id.replace(/"/g, '\\"');
}

export function captchaPresent(root: ParentNode): boolean {
  return Boolean(
    (root as Document | Element).querySelector?.(
      '.g-recaptcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [data-sitekey]',
    ),
  );
}

export function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const parsed = Date.parse(d);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function guessLanguage(doc: Document, text: string): string | undefined {
  const lang = doc.documentElement.lang?.trim().toLowerCase();
  if (lang) return lang.slice(0, 2);
  if (/[æøåÆØÅ]/.test(text) || /\b(ansøg|stilling|virksomhed)\b/i.test(text)) return 'da';
  return undefined;
}

export function companyDomainFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.')) return undefined;
    if (/(greenhouse|lever|ashbyhq|myworkdayjobs|linkedin|indeed|smartrecruiters|icims)\./.test(host)) return undefined;
    return host;
  } catch {
    return undefined;
  }
}
