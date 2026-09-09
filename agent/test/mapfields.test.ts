import { describe, expect, it } from 'vitest';
import { mapFields, matchOption } from '../src/pipeline/mapFields.js';
import type { Llm } from '../src/integrations/llm.js';
import type { ApplicationJob, FormField, FormSchema } from '../src/protocol.js';

const select: FormField = {
  id: 's1',
  kind: 'select',
  label: 'Country',
  required: true,
  options: [
    { value: 'US', label: 'United States' },
    { value: 'DK', label: 'Denmark' },
    { value: 'DE', label: 'Germany' },
  ],
};

describe('matchOption', () => {
  it('matches by value or label, case-insensitively, with a unique-contains fallback', () => {
    expect(matchOption(select, 'DK')).toEqual({ value: 'DK', label: 'Denmark' });
    expect(matchOption(select, 'denmark')).toEqual({ value: 'DK', label: 'Denmark' });
    expect(matchOption(select, 'United')).toEqual({ value: 'US', label: 'United States' });
    expect(matchOption(select, 'France')).toBeUndefined();
    expect(matchOption(select, '')).toBeUndefined();
  });
});

function fakeLlm(answers: unknown[]): Llm {
  return { structured: async () => ({ value: { answers }, backend: 'anthropic' as const }) } as unknown as Llm;
}

const job = {
  id: 'j1',
  posting: { company: 'Acme', title: 'ML Engineer', url: 'https://x', description: '', ats: 'greenhouse', source: 'jsonld', hasInlineForm: true },
  formAnswers: [{ question: 'Why Acme?', answer: 'Because of the work on X.' }],
} as unknown as ApplicationJob;

const profile = { candidateProfileMd: '# profile', claudeMdProfile: '', writingStyleMd: '', answers: {} };

describe('mapFields normalisation', () => {
  const form: FormSchema = {
    url: 'https://x',
    ats: 'greenhouse',
    captchaDetected: false,
    fields: [
      select,
      { id: 't1', kind: 'textarea', label: 'Why Acme?', required: false, maxLength: 20 },
      { id: 'f1', kind: 'file', label: 'Resume', required: true },
      { id: 'c1', kind: 'combobox', label: 'School', required: false },
      { id: 'h1', kind: 'hidden', label: '', required: false },
      { id: 'x1', kind: 'text', label: 'Forgotten', required: true },
    ],
  };

  it('validates options, truncates to maxLength, types into comboboxes, fills forgotten fields with skips', async () => {
    const llm = fakeLlm([
      { fieldId: 's1', kind: 'option', value: 'denmark', confidence: 0.95, source: 'answers' },
      { fieldId: 't1', kind: 'text', value: 'Because of the work on X. And more words here.', confidence: 0.9, source: 'drafted' },
      { fieldId: 'f1', kind: 'file', file: 'cv', confidence: 1, source: 'profile' },
      { fieldId: 'c1', kind: 'option', value: 'MIT', confidence: 0.9, source: 'profile' },
      { fieldId: 'zzz', kind: 'text', value: 'ignored unknown field', confidence: 1, source: 'profile' },
    ]);
    const answers = await mapFields(llm, { job, form, profile });
    const byId = Object.fromEntries(answers.map((a) => [a.fieldId, a]));
    expect(byId.s1!.answer).toEqual({ type: 'option', value: 'DK', label: 'Denmark' });
    expect(byId.t1!.answer).toMatchObject({ type: 'text' });
    expect((byId.t1!.answer as { value: string }).value.length).toBeLessThanOrEqual(20);
    expect(byId.f1!.answer).toEqual({ type: 'file', file: 'cv' });
    expect(byId.c1!.answer).toEqual({ type: 'text', value: 'MIT' });
    expect(byId.c1!.confidence).toBeLessThanOrEqual(0.7);
    expect(byId.x1!.answer.type).toBe('skip');
    expect(byId.zzz).toBeUndefined();
    expect(byId.h1).toBeUndefined(); // hidden fields are never mapped
  });

  it('turns an option that does not exist into a skip', async () => {
    const llm = fakeLlm([{ fieldId: 's1', kind: 'option', value: 'France', confidence: 0.95, source: 'answers' }]);
    const answers = await mapFields(llm, { job, form: { ...form, fields: [select] }, profile });
    expect(answers[0]!.answer.type).toBe('skip');
    expect(answers[0]!.confidence).toBe(0);
  });
});
