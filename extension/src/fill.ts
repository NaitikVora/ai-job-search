import type { FieldAnswer, FieldAnswerValue } from '@protocol';
import { adapterFor } from './adapters';
import { base64ToBytes } from './client';
import { AUTOPILOT_ID_ATTR, fieldElement } from './scan';
import { textOf } from './dom';
import type { FilePayload, FillPayload, FillResult } from './messaging';

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function click(el: Element): void {
  if (el instanceof HTMLElement) el.click();
}

function applyFile(el: HTMLInputElement, file: FilePayload): void {
  const bytes = base64ToBytes(file.base64);
  const blob = new File([bytes], file.name, { type: file.mime });
  const dt = new DataTransfer();
  dt.items.add(blob);
  el.files = dt.files;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function matchOptionEl(root: ParentNode, wanted: string): Element | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const w = norm(wanted);
  const options = [...root.querySelectorAll('option, [role="option"], li')];
  return (
    options.find((o) => {
      const value = (o instanceof HTMLOptionElement ? o.value : o.getAttribute('data-value')) ?? '';
      const label = textOf(o);
      return norm(value) === w || norm(label) === w;
    }) ??
    options.find((o) => textOf(o).toLowerCase().includes(w)) ??
    null
  );
}

function applyOption(el: Element, value: string, label?: string): boolean {
  const wanted = value || label || '';
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find(
      (o) => o.value === value || o.text.trim() === (label ?? value) || o.text.trim().toLowerCase() === wanted.toLowerCase(),
    );
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    const group = el.ownerDocument.querySelectorAll(`input[type="radio"][name="${el.name}"]`);
    for (const node of group) {
      const r = node as HTMLInputElement;
      const lab = r.labels?.[0] ? textOf(r.labels[0]) : r.value;
      if (r.value === value || lab === label || lab.toLowerCase() === wanted.toLowerCase()) {
        r.checked = true;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }
  // Custom dropdown / combobox: open, then click the matching option.
  click(el);
  if (el instanceof HTMLInputElement) setNativeValue(el, label ?? value);
  const owner = el.closest('[data-automation-id], .select, [class*="dropdown"]') ?? el.parentElement ?? el;
  const opt = matchOptionEl(el.ownerDocument, wanted) ?? matchOptionEl(owner, wanted);
  if (opt) {
    click(opt);
    return true;
  }
  return Boolean(label ?? value);
}

function applyBoolean(el: Element, value: boolean): void {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.checked !== value) click(el);
    return;
  }
  if (value) click(el);
}

function applyOptions(el: Element, values: string[]): void {
  if (el instanceof HTMLSelectElement && el.multiple) {
    for (const opt of el.options) opt.selected = values.includes(opt.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (el instanceof HTMLInputElement && el.name) {
    const group = el.ownerDocument.querySelectorAll(`input[type="checkbox"][name="${el.name}"]`);
    for (const node of group) {
      const box = node as HTMLInputElement;
      const want = values.includes(box.value);
      if (box.checked !== want) click(box);
    }
  }
}

function applyOne(el: Element, answer: FieldAnswerValue, files: FillPayload['files']): string | undefined {
  switch (answer.type) {
    case 'skip':
      return undefined;
    case 'text':
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, answer.value);
        return undefined;
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = answer.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return undefined;
      }
      return applyOption(el, answer.value) ? undefined : `could not type into ${el.tagName}`;
    case 'option':
      return applyOption(el, answer.value, answer.label) ? undefined : `option ${answer.value} not found`;
    case 'options':
      applyOptions(el, answer.values);
      return undefined;
    case 'boolean':
      applyBoolean(el, answer.value);
      return undefined;
    case 'file': {
      const payload = files[answer.file];
      if (!payload) return `no ${answer.file} file from daemon`;
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return 'target is not a file input';
      applyFile(el, payload);
      return undefined;
    }
  }
}

export function fillForm(doc: Document, payload: FillPayload): FillResult {
  let filled = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const a of payload.answers) {
    if (a.answer.type === 'skip') {
      skipped += 1;
      continue;
    }
    const el = fieldElement(doc, a.fieldId);
    if (!el) {
      errors.push(`missing element ${a.fieldId}`);
      skipped += 1;
      continue;
    }
    const err = applyOne(el, a.answer, payload.files);
    if (err) {
      errors.push(`${a.fieldId}: ${err}`);
      skipped += 1;
    } else {
      filled += 1;
    }
  }
  void AUTOPILOT_ID_ATTR;
  void adapterFor;
  return { filled, skipped, errors };
}
