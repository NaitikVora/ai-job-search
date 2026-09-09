import { describe, expect, it } from 'vitest';
import { detectAts, looksLikeJobPage } from '../src/detect';

describe('detectAts', () => {
  it('routes Greenhouse / Lever / Ashby / Workday / LinkedIn hostnames', () => {
    expect(detectAts('https://boards.greenhouse.io/figma/jobs/123')).toBe('greenhouse');
    expect(detectAts('https://job-boards.greenhouse.io/acme/jobs/9')).toBe('greenhouse');
    expect(detectAts('https://jobs.lever.co/netflix/abc')).toBe('lever');
    expect(detectAts('https://jobs.ashbyhq.com/anthropic/abc')).toBe('ashby');
    expect(detectAts('https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/X/Y_R1')).toBe('workday');
    expect(detectAts('https://www.linkedin.com/jobs/view/123')).toBe('linkedin');
    expect(detectAts('https://www.indeed.com/viewjob?jk=abc')).toBe('indeed');
    expect(detectAts('https://jobs.smartrecruiters.com/Acme/123')).toBe('smartrecruiters');
    expect(detectAts('https://acme.icims.com/jobs/1')).toBe('icims');
    expect(detectAts('https://careers.example.com/role')).toBe('unknown');
  });
});

describe('looksLikeJobPage', () => {
  it('treats known ATS URLs as job pages even without JSON-LD', () => {
    const doc = document.implementation.createHTMLDocument('x');
    expect(looksLikeJobPage('https://jobs.lever.co/x/y', doc)).toBe(true);
  });
  it('detects a JobPosting JSON-LD script', () => {
    const doc = document.implementation.createHTMLDocument('Home');
    const s = doc.createElement('script');
    s.type = 'application/ld+json';
    s.textContent = '{"@type":"JobPosting","title":"X"}';
    doc.head.appendChild(s);
    expect(looksLikeJobPage('https://example.com/foo', doc)).toBe(true);
  });
});
