import { z } from 'zod';
import type { AutoapplyResult } from '../protocol.js';

/** JSON Schema handed to the Agent SDK as `outputFormat` for /autoapply. Keep in sync with the zod schema below. */
export const AUTOAPPLY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'role', 'slug', 'fit', 'proceeded', 'files', 'formAnswers', 'verification', 'trackerRowWritten'],
  properties: {
    company: { type: 'string' },
    role: { type: 'string' },
    slug: { type: 'string', description: '<company>_<role> per documents/README.md Subfolder naming' },
    location: { type: 'string' },
    deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD or null; never inferred' },
    postingLanguage: { type: 'string' },
    fit: {
      type: 'object',
      additionalProperties: false,
      required: ['overall', 'verdict', 'locationGate', 'languageGate', 'dealBreakers', 'strengths', 'gaps'],
      properties: {
        overall: { type: 'number', minimum: 0, maximum: 100 },
        verdict: { type: 'string' },
        technical: { type: 'number' },
        experience: { type: 'number' },
        behavioral: { type: 'number' },
        career: { type: 'number' },
        locationGate: { type: 'string', enum: ['PASS', 'FAIL', 'FLAG'] },
        languageGate: { type: 'string', enum: ['PASS', 'FAIL', 'FLAG'] },
        dealBreakers: { type: 'array', items: { type: 'string' } },
        strengths: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    proceeded: { type: 'boolean' },
    skipReason: { type: 'string' },
    files: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cvSource: { type: 'string' },
        cvPdf: { type: 'string' },
        coverSource: { type: 'string' },
        coverPdf: { type: 'string' },
        formFieldsTxt: { type: 'string' },
        resultJson: { type: 'string' },
      },
    },
    formAnswers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          shortAnswer: { type: 'string' },
          wordCount: { type: 'number' },
        },
      },
    },
    verification: {
      type: 'object',
      additionalProperties: false,
      required: ['notes'],
      properties: {
        cvPages: { type: 'number' },
        coverPages: { type: 'number' },
        atsOk: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    trackerRowWritten: { type: 'boolean' },
  },
};

const Gate = z.enum(['PASS', 'FAIL', 'FLAG']);

export const AutoapplyResultSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  slug: z.string(),
  location: z.string().optional(),
  deadline: z.string().nullable().optional(),
  postingLanguage: z.string().optional(),
  fit: z.object({
    overall: z.number().min(0).max(100),
    verdict: z.string(),
    technical: z.number().optional(),
    experience: z.number().optional(),
    behavioral: z.number().optional(),
    career: z.number().optional(),
    locationGate: Gate.default('PASS'),
    languageGate: Gate.default('PASS'),
    dealBreakers: z.array(z.string()).default([]),
    strengths: z.array(z.string()).default([]),
    gaps: z.array(z.string()).default([]),
  }),
  proceeded: z.boolean(),
  skipReason: z.string().optional(),
  files: z
    .object({
      cvSource: z.string().optional(),
      cvPdf: z.string().optional(),
      coverSource: z.string().optional(),
      coverPdf: z.string().optional(),
      formFieldsTxt: z.string().optional(),
      resultJson: z.string().optional(),
    })
    .default({}),
  formAnswers: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        shortAnswer: z.string().optional(),
        wordCount: z.number().optional(),
      }),
    )
    .default([]),
  verification: z
    .object({
      cvPages: z.number().optional(),
      coverPages: z.number().optional(),
      atsOk: z.boolean().optional(),
      notes: z.array(z.string()).default([]),
    })
    .default({ notes: [] }),
  trackerRowWritten: z.boolean().default(false),
});

export function parseAutoapplyResult(value: unknown): AutoapplyResult {
  return AutoapplyResultSchema.parse(value) as AutoapplyResult;
}
