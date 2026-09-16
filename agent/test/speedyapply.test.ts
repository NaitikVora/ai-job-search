import { describe, expect, it } from 'vitest';
import {
  canonicalJobUrl,
  githubRawUrl,
  guessAts,
  ineligibleReason,
  isEligibleSpeedyApplyJob,
  parseAgeHours,
  parseSpeedyApplyMarkdown,
  speedyJobToPosting,
} from '../src/pipeline/speedyapply.js';

const FEED = `
### FAANG+

| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://amazon.com"><strong>Amazon</strong></a> | Older Role | Seattle, WA | $180k/yr | <a href="https://amazon.jobs/jobs/2/apply?utm_source=foo"><img alt="Apply"/></a> | 4d |
| <a href="https://openai.com"><strong>OpenAI</strong></a> | Software Engineer - Applied Emerging Talent - 2027 | San Francisco, CA | $200k/yr | <a href="https://jobs.ashbyhq.com/openai/abc"><img alt="Apply"/></a> | 0d |

### Quant

| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://jane.com"><strong>Jane Street</strong></a> | Quant Dev | New York, NY | $250k/yr | <a href="https://jane.example/jobs/q1"><img alt="Apply"/></a> | 1d |
| <a href="https://jane.com"><strong>Jane Street</strong></a> | Duplicate | New York, NY | $250k/yr | <a href="https://jane.example/jobs/q1?utm_campaign=x"><img alt="Apply"/></a> | 2d |

### Other

| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| <a href="https://small.example"><strong>Small &amp; Co</strong></a> | SWE <br> New Grad | Remote | <a href="https://small.example/jobs/9"><img alt="Apply"/></a> | 1d |
| <a href="https://spacex.com"><strong>SpaceX</strong></a> | Software Engineer, Starshield | Hawthorne, CA | <a href="https://spacex.com/careers/starshield"><img alt="Apply"/></a> | 0d |
| <a href="https://boozallen.com"><strong>Booz Allen</strong></a> | Software Engineer | McLean, VA | <a href="https://careers.boozallen.com/x"><img alt="Apply"/></a> | 0d |
| <a href="https://ufl.edu"><strong>UF Lab</strong></a> | SWE (UF Only) | Gainesville, FL | <a href="https://ufl.example/jobs/1"><img alt="Apply"/></a> | 3h |
`;

describe('githubRawUrl', () => {
  it('converts the SpeedyApply blob link into the raw markdown URL', () => {
    expect(
      githubRawUrl('https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md'),
    ).toBe('https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md');
  });

  it('rejects plaintext HTTP feeds', () => {
    expect(() => githubRawUrl('http://example.com/feed.md')).toThrow(/HTTPS/);
  });
});

describe('parseSpeedyApplyMarkdown', () => {
  it('parses FAANG+ salary tables and Other tables without Salary', () => {
    const jobs = parseSpeedyApplyMarkdown(FEED);
    expect(jobs.map((job) => job.title)).toEqual([
      'Software Engineer - Applied Emerging Talent - 2027',
      'Software Engineer, Starshield',
      'Software Engineer',
      'SWE (UF Only)',
      'Quant Dev',
      'SWE / New Grad',
      'Older Role',
    ]);
    expect(jobs[0]).toMatchObject({
      company: 'OpenAI',
      section: 'FAANG+',
      ageLabel: '0d',
      ageHours: 0,
      salary: '$200k/yr',
    });
    expect(jobs.find((job) => job.company === 'Small & Co')).toMatchObject({
      section: 'Other',
      title: 'SWE / New Grad',
      salary: undefined,
    });
  });

  it('deduplicates tracking variants of the same apply URL', () => {
    const jobs = parseSpeedyApplyMarkdown(FEED);
    expect(jobs.filter((job) => job.company === 'Jane Street')).toHaveLength(1);
  });
});

describe('eligibility', () => {
  it('skips Starshield, Booz Allen, and school-locked titles', () => {
    const jobs = parseSpeedyApplyMarkdown(FEED);
    const eligible = jobs.filter(isEligibleSpeedyApplyJob);
    expect(eligible.map((job) => job.company)).toEqual(['OpenAI', 'Jane Street', 'Small & Co', 'Amazon']);
    expect(ineligibleReason({ company: 'SpaceX', title: 'Software Engineer, Starshield' })).toMatch(/Starshield/);
    expect(ineligibleReason({ company: 'Booz Allen', title: 'Software Engineer' })).toMatch(/Booz Allen/);
  });
});

describe('age, ATS, and posting conversion', () => {
  it('parses relative ages', () => {
    expect(parseAgeHours('3h')).toBe(3);
    expect(parseAgeHours('2d')).toBe(48);
    expect(parseAgeHours('today')).toBe(0);
  });

  it('guesses ATS from the apply host and builds a metadata posting', () => {
    expect(guessAts('https://jobs.ashbyhq.com/openai/abc')).toBe('ashby');
    const job = parseSpeedyApplyMarkdown(FEED)[0]!;
    const posting = speedyJobToPosting(job);
    expect(posting).toMatchObject({
      company: 'OpenAI',
      title: job.title,
      url: job.url,
      ats: 'ashby',
      source: 'manual',
    });
    expect(posting.description).toMatch(/Fetch the Apply URL/);
  });

  it('keeps job-selector query params while dropping utm tags', () => {
    expect(canonicalJobUrl('https://x.test/jobs?gh_jid=9&utm_source=repo#apply')).toBe(
      'https://x.test/jobs?gh_jid=9',
    );
  });
});
