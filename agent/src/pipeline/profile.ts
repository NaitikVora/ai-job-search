import path from 'node:path';
import type { Paths } from '../config.js';
import { readJson, readTextIfExists } from '../util/fs.js';

/**
 * Standing answers for application-form questions that the CV/profile do not cover
 * (work authorisation, salary, notice period, EEO policy...). Created from
 * agent/profile/answers.example.json; every field optional.
 */
export interface StandingAnswers {
  contact?: {
    firstName?: string;
    lastName?: string;
    preferredName?: string;
    email?: string;
    phone?: string;
    phoneCountryCode?: string;
    address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
    linkedin?: string;
    github?: string;
    portfolio?: string;
    website?: string;
  };
  workAuthorization?: Record<string, { authorized?: boolean; requiresSponsorship?: boolean; status?: string; notes?: string }>;
  preferences?: {
    salaryExpectation?: string;
    salaryCurrency?: string;
    noticePeriod?: string;
    earliestStartDate?: string;
    willingToRelocate?: boolean;
    remotePreference?: string;
    howDidYouHear?: string;
    yearsOfExperience?: string;
    currentCompany?: string;
    currentTitle?: string;
    previouslyEmployedHere?: boolean;
    referredBy?: string;
  };
  demographics?: {
    /** `decline`: choose "prefer not to answer"/"decline" options. `answer`: use the values below. */
    policy?: 'decline' | 'answer';
    gender?: string;
    ethnicity?: string;
    veteranStatus?: string;
    disabilityStatus?: string;
    pronouns?: string;
  };
  consents?: {
    privacyPolicy?: boolean;
    termsAndConditions?: boolean;
    futureOpportunities?: boolean;
    marketing?: boolean;
    backgroundCheck?: boolean;
  };
  education?: Array<{ school?: string; degree?: string; field?: string; startYear?: string; endYear?: string; gpa?: string }>;
  experience?: Array<{ company?: string; title?: string; location?: string; startDate?: string; endDate?: string; current?: boolean; description?: string }>;
  custom?: Array<{ question: string; answer: string }>;
}

export interface ProfileContext {
  candidateProfileMd: string;
  claudeMdProfile: string;
  writingStyleMd: string;
  answers: StandingAnswers;
}

/** Slice CLAUDE.md down to its Candidate Profile section (the repo's third grounding source). */
export function extractCandidateProfileSection(claudeMd: string): string {
  const start = claudeMd.indexOf('## Candidate Profile');
  if (start === -1) return '';
  const rest = claudeMd.slice(start + '## Candidate Profile'.length);
  const next = rest.search(/\n## /);
  return rest.slice(0, next === -1 ? undefined : next).trim();
}

export function loadProfileContext(paths: Paths): ProfileContext {
  const candidateProfileMd = readTextIfExists(path.join(paths.skillDir, '01-candidate-profile.md')) ?? '';
  const claudeMd = readTextIfExists(path.join(paths.repoRoot, 'CLAUDE.md')) ?? '';
  const writingStyleMd = readTextIfExists(path.join(paths.skillDir, '03-writing-style.md')) ?? '';
  const answers = readJson<StandingAnswers>(paths.answersFile, {});
  return {
    candidateProfileMd,
    claudeMdProfile: extractCandidateProfileSection(claudeMd),
    writingStyleMd,
    answers,
  };
}

/** True when /setup has not been run: the profile still carries the template's [PLACEHOLDER] tokens. */
export function profileLooksUnpopulated(ctx: ProfileContext): boolean {
  const text = `${ctx.claudeMdProfile}\n${ctx.candidateProfileMd}`;
  return /\[YOUR_NAME\]|\[YOUR_CITY\]|\[INSTITUTION\]|\[COMPANY\]/.test(text) || text.trim().length < 200;
}

/** Trim very long profile files so the mapping prompt stays within a sane size. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} chars...]`;
}
