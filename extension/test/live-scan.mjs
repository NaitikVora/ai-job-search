import { JSDOM } from 'jsdom';
import { scanForm } from '../src/scan.ts';

const url = process.argv[2] ?? 'https://job-boards.greenhouse.io/figma/jobs/5426468004';
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow' });
const html = await res.text();
const dom = new JSDOM(html, { url: res.url });
for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLAnchorElement']) {
  globalThis[key] = dom.window[key];
}
const schema = scanForm(dom.window.document, res.url);
console.log(
  JSON.stringify(
    {
      url: res.url,
      status: res.status,
      ats: schema.ats,
      fields: schema.fields.length,
      captcha: schema.captchaDetected,
      submit: schema.submitLabel,
      sample: schema.fields.slice(0, 10).map((f) => ({ kind: f.kind, label: f.label.slice(0, 60), required: f.required })),
    },
    null,
    2,
  ),
);
