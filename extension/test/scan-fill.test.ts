import { describe, expect, it } from 'vitest';
import { fillForm } from '../src/fill';
import { AUTOPILOT_ID_ATTR, scanForm } from '../src/scan';
import { clickSubmit, confirmationText, findSubmitButton, looksSubmitted } from '../src/submit';

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

const FORM = `
<form id="application-form">
  <label for="first">First name *</label>
  <input id="first" name="first_name" required />
  <label for="why">Why us?</label>
  <textarea id="why" name="why" maxlength="200"></textarea>
  <label for="country">Country</label>
  <select id="country" name="country">
    <option value="">Choose</option>
    <option value="US">United States</option>
    <option value="DK">Denmark</option>
  </select>
  <fieldset>
    <legend>Work authorisation</legend>
    <label><input type="radio" name="auth" value="yes" /> Yes</label>
    <label><input type="radio" name="auth" value="no" /> No</label>
  </fieldset>
  <label><input type="checkbox" name="privacy" /> I agree</label>
  <label>Resume <input type="file" name="resume" accept=".pdf" /></label>
  <button type="submit" id="submit_app">Submit application</button>
</form>
`;

describe('scanForm', () => {
  it('assigns stable ids, kinds, labels, options and required flags', () => {
    const doc = mount(FORM);
    const schema = scanForm(doc, 'https://boards.greenhouse.io/acme/jobs/1');
    expect(schema.ats).toBe('greenhouse');
    expect(schema.captchaDetected).toBe(false);
    expect(schema.submitLabel).toMatch(/Submit/i);
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name ?? f.id, f]));
    expect(byName.first_name).toMatchObject({ kind: 'text', required: true, label: expect.stringMatching(/First name/i) });
    expect(byName.why).toMatchObject({ kind: 'textarea', maxLength: 200 });
    expect(byName.country?.kind).toBe('select');
    expect(byName.country?.options).toEqual(
      expect.arrayContaining([
        { value: 'DK', label: 'Denmark' },
        { value: 'US', label: 'United States' },
      ]),
    );
    expect(byName.auth?.kind).toBe('radio');
    expect(byName.privacy?.kind).toBe('checkbox');
    expect(byName.resume?.kind).toBe('file');
    expect(doc.querySelectorAll(`[${AUTOPILOT_ID_ATTR}]`).length).toBeGreaterThan(4);
  });

  it('flags a CAPTCHA widget', () => {
    mount(`${FORM}<div class="g-recaptcha" data-sitekey="x"></div>`);
    expect(scanForm(document, 'https://example.com/apply').captchaDetected).toBe(true);
  });
});

describe('fillForm', () => {
  it('writes text, selects an option, checks boxes and radios', () => {
    const doc = mount(FORM);
    const schema = scanForm(doc, 'https://jobs.lever.co/acme/1');
    const id = (name: string) => schema.fields.find((f) => f.name === name)!.id;
    const result = fillForm(doc, {
      files: {},
      answers: [
        { fieldId: id('first_name'), answer: { type: 'text', value: 'Ada' }, confidence: 1, source: 'answers' },
        { fieldId: id('country'), answer: { type: 'option', value: 'DK', label: 'Denmark' }, confidence: 1, source: 'answers' },
        { fieldId: id('auth'), answer: { type: 'option', value: 'yes' }, confidence: 1, source: 'answers' },
        { fieldId: id('privacy'), answer: { type: 'boolean', value: true }, confidence: 1, source: 'answers' },
        { fieldId: id('why'), answer: { type: 'skip', reason: 'optional' }, confidence: 0, source: 'none' },
      ],
    });
    expect(result.filled).toBe(4);
    expect(result.skipped).toBe(1);
    expect((doc.getElementById('first') as HTMLInputElement).value).toBe('Ada');
    expect((doc.getElementById('country') as HTMLSelectElement).value).toBe('DK');
    expect((doc.querySelector('input[name="auth"][value="yes"]') as HTMLInputElement).checked).toBe(true);
    expect((doc.querySelector('input[name="privacy"]') as HTMLInputElement).checked).toBe(true);
  });

  it('skips missing elements instead of throwing', () => {
    mount(FORM);
    scanForm(document, 'https://example.com');
    const result = fillForm(document, {
      files: {},
      answers: [{ fieldId: 'nope', answer: { type: 'text', value: 'x' }, confidence: 1, source: 'answers' }],
    });
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatch(/missing/);
  });
});

describe('submit helpers', () => {
  it('finds the Greenhouse submit button and confirmation copy', () => {
    mount(`${FORM}<h1>Thank you, your application has been received</h1>`);
    const url = 'https://boards.greenhouse.io/acme/jobs/1';
    expect(findSubmitButton(document, url)?.id).toBe('submit_app');
    expect(looksSubmitted(document, url)).toBe(true);
    expect(confirmationText(document, url)).toMatch(/received/i);
  });

  it('advances multi-step forms but never clicks the final button in review mode', () => {
    mount(`
      <form>
        <button id="next" type="button" data-automation-id="bottom-navigation-next-button">Next</button>
        <button id="final" type="submit" data-automation-id="submit-application">Submit application</button>
      </form>
    `);
    document.querySelector('form')!.addEventListener('submit', (event) => event.preventDefault());
    let nextClicks = 0;
    let finalClicks = 0;
    document.getElementById('next')!.addEventListener('click', () => nextClicks++);
    document.getElementById('final')!.addEventListener('click', () => finalClicks++);
    const url = 'https://acme.wd1.myworkdayjobs.com/en-US/jobs/1';

    const first = clickSubmit(document, url, { allowFinal: false });
    expect(first.nextClicked).toBe(true);
    expect(nextClicks).toBe(1);
    expect(finalClicks).toBe(0);

    document.getElementById('next')!.remove();
    const final = clickSubmit(document, url, { allowFinal: false });
    expect(final).toMatchObject({ submitted: false });
    expect(final.finalClicked).toBeUndefined();
    expect(finalClicks).toBe(0);
  });
});
