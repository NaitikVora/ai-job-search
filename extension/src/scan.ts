import type { FieldKind, FieldOption, FormField, FormSchema } from '@protocol';
import { adapterFor } from './adapters';
import { detectAts } from './detect';
import { captchaPresent, closestLabel, textOf, visible } from './dom';

const ATTR = 'data-autopilot-id';
const SKIP_TYPES = new Set(['button', 'submit', 'reset', 'image', 'search']);

function fieldKind(el: Element): FieldKind {
  if (el instanceof HTMLSelectElement) return el.multiple ? 'checkbox-group' : 'select';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (!(el instanceof HTMLInputElement)) {
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
    if (el.getAttribute('contenteditable') === 'true') return 'textarea';
    return 'unknown';
  }
  const type = (el.type || 'text').toLowerCase();
  if (type === 'hidden') return 'hidden';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';
  if (type === 'url') return 'url';
  if (type === 'number') return 'number';
  if (type === 'date' || type === 'datetime-local' || type === 'month') return 'date';
  if (type === 'file') return 'file';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('list')) return 'combobox';
  if (type === 'text' || type === 'password') return 'text';
  return 'text';
}

function optionsOf(el: Element): FieldOption[] | undefined {
  if (el instanceof HTMLSelectElement) {
    return [...el.options].map((o) => ({ value: o.value, label: o.textContent?.trim() || o.value }));
  }
  if (el instanceof HTMLInputElement && el.list) {
    return [...el.list.options].map((o) => ({ value: o.value, label: o.label || o.value }));
  }
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && el.name) {
    const group = el.ownerDocument.querySelectorAll(`input[name="${cssEscapeAttr(el.name)}"]`);
    if (group.length > 1) {
      return [...group].map((n) => {
        const input = n as HTMLInputElement;
        return { value: input.value || 'on', label: closestLabel(input) || input.value || 'on' };
      });
    }
  }
  const listbox = el.getAttribute('aria-controls');
  if (listbox) {
    const box = el.ownerDocument.getElementById(listbox);
    if (box) {
      const items = [...box.querySelectorAll('[role="option"]')];
      if (items.length) {
        return items.map((item, i) => ({
          value: item.getAttribute('data-value') ?? item.getAttribute('id') ?? String(i),
          label: textOf(item),
        }));
      }
    }
  }
  return undefined;
}

function cssEscapeAttr(v: string): string {
  return v.replace(/"/g, '\\"');
}

function currentValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? el.value || 'true' : '';
    return el.value || undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value || undefined;
  if (el instanceof HTMLSelectElement) return el.value || undefined;
  return undefined;
}

function requiredOf(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.required) return true;
  }
  if (el.getAttribute('aria-required') === 'true') return true;
  const label = closestLabel(el);
  return /\*$|required/i.test(label);
}

function contextOf(el: Element): string | undefined {
  const section = el.closest('fieldset, section, [role="group"]');
  if (!section) return undefined;
  const heading = section.querySelector('legend, h2, h3, h4, [class*="heading"]');
  const t = textOf(heading);
  return t || undefined;
}

function candidates(root: Element | Document): Element[] {
  const nodes = [
    ...root.querySelectorAll('input, textarea, select, [role="combobox"], [contenteditable="true"]'),
  ];
  const seen = new Set<Element>();
  const out: Element[] = [];
  const radioNames = new Set<string>();
  const checkboxGroupNames = new Set<string>();
  for (const el of nodes) {
    if (seen.has(el)) continue;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || '').toLowerCase();
      if (SKIP_TYPES.has(type)) continue;
      if (type === 'radio' && el.name) {
        if (radioNames.has(el.name)) continue;
        radioNames.add(el.name);
      }
      if (type === 'checkbox' && el.name) {
        const group = el.ownerDocument.querySelectorAll(`input[type="checkbox"][name="${cssEscapeAttr(el.name)}"]`);
        if (group.length > 1) {
          if (checkboxGroupNames.has(el.name)) continue;
          checkboxGroupNames.add(el.name);
        }
      }
    }
    const kind = fieldKind(el);
    if (kind === 'hidden' || visible(el) || (el instanceof HTMLInputElement && el.type === 'hidden')) {
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

export function scanForm(doc: Document, url: string): FormSchema {
  const adapter = adapterFor(url);
  const root = (adapter.formRoot(doc) as Element | null) ?? doc.body;
  const fields: FormField[] = [];
  let i = 0;
  for (const el of candidates(root)) {
    i += 1;
    const id = el.getAttribute(ATTR) || `ap-${i}`;
    el.setAttribute(ATTR, id);
    let kind = fieldKind(el);
    if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.name) {
      const group = el.ownerDocument.querySelectorAll(`input[type="checkbox"][name="${cssEscapeAttr(el.name)}"]`);
      if (group.length > 1) kind = 'checkbox-group';
    }
    const opts = optionsOf(el);
    fields.push({
      id,
      kind,
      label: closestLabel(el) || el.getAttribute('name') || id,
      context: contextOf(el),
      name: (el as HTMLInputElement).name || undefined,
      placeholder: (el as HTMLInputElement).placeholder || undefined,
      required: requiredOf(el),
      options: opts,
      currentValue: currentValue(el),
      maxLength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : undefined,
      accept: el instanceof HTMLInputElement && el.type === 'file' ? el.accept || undefined : undefined,
      automationId: el.getAttribute('data-automation-id') || undefined,
    });
  }

  const submit = root.querySelector(adapter.submitSelector);
  return {
    url,
    ats: detectAts(url),
    fields,
    captchaDetected: captchaPresent(doc),
    submitLabel: textOf(submit) || submit?.getAttribute('value') || undefined,
  };
}

export function fieldElement(doc: Document, id: string): Element | null {
  return doc.querySelector(`[${ATTR}="${id}"]`);
}

export { ATTR as AUTOPILOT_ID_ATTR };
