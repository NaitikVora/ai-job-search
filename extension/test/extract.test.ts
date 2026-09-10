import { describe, expect, it } from 'vitest';
import { extractPosting } from '../src/extract';
import { parseJobPostingLd } from '../src/jsonld';

const JOB_LD = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Machine Learning Engineer',
  description: '<p>Build models for climate risk and write production Python.</p>',
  datePosted: '2026-09-01',
  validThrough: '2026-10-15T00:00:00Z',
  hiringOrganization: { '@type': 'Organization', name: 'Acme Corp', url: 'https://www.acme.com' },
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Copenhagen', addressCountry: 'DK' } },
};

describe('parseJobPostingLd', () => {
  it('reads a JobPosting, including @graph wrappers', () => {
    expect(parseJobPostingLd(JOB_LD)).toMatchObject({
      title: 'Machine Learning Engineer',
      company: 'Acme Corp',
      location: 'Copenhagen, DK',
      deadline: '2026-10-15',
      datePosted: '2026-09-01',
    });
    expect(parseJobPostingLd({ '@graph': [JOB_LD] })?.title).toBe('Machine Learning Engineer');
    expect(parseJobPostingLd({ '@type': 'WebPage' })).toBeNull();
  });
  it('strips HTML from the description', () => {
    expect(parseJobPostingLd(JOB_LD)?.description).toContain('Build models');
    expect(parseJobPostingLd(JOB_LD)?.description).not.toContain('<p>');
  });
});

function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument('job');
  doc.documentElement.innerHTML = html;
  return doc;
}

describe('extractPosting', () => {
  it('prefers JSON-LD over adapter text and records the ATS', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1';
    const doc = page(
      `<head><script type="application/ld+json">${JSON.stringify(JOB_LD)}</script></head>
       <body><h1>Wrong title</h1><div id="content">${'x'.repeat(50)}</div></body>`,
    );
    const posting = extractPosting(doc, url);
    expect(posting).toMatchObject({
      ats: 'greenhouse',
      title: 'Machine Learning Engineer',
      company: 'Acme Corp',
      source: 'jsonld',
      companyDomain: 'acme.com',
    });
    expect(posting?.description.length).toBeGreaterThan(40);
  });

  it('falls back to the Greenhouse adapter when JSON-LD is missing', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1';
    const doc = page(
      `<body>
        <div id="header"><h1 class="app-title">Staff Engineer</h1><div class="company-name">Figma</div><div class="location">SF</div></div>
        <div id="content"><p>${'Design systems and TypeScript. '.repeat(8)}</p></div>
        <a id="apply_button" href="#app">Apply</a>
      </body>`,
    );
    const posting = extractPosting(doc, url);
    expect(posting).toMatchObject({ ats: 'greenhouse', title: 'Staff Engineer', company: 'Figma', source: 'adapter' });
  });

  it('extracts Lever and Ashby markup', () => {
    const lever = extractPosting(
      page(
        `<body>
          <div class="main-header-logo"><img alt="Netflix"></div>
          <div class="posting-headline"><h2>Backend Engineer</h2></div>
          <div class="posting-categories"><div class="location">Remote</div></div>
          <div class="section-wrapper"><div class="content"><p>${'Stream playback at scale. '.repeat(8)}</p></div></div>
        </body>`,
      ),
      'https://jobs.lever.co/netflix/abc',
    );
    expect(lever).toMatchObject({ ats: 'lever', title: 'Backend Engineer', company: 'Netflix' });

    const ashby = extractPosting(
      page(
        `<body>
          <header><a href="/">Anthropic</a></header>
          <h1>Research Engineer</h1>
          <article class="JobDescription"><p>${'Interpretability and safety. '.repeat(8)}</p></article>
        </body>`,
      ),
      'https://jobs.ashbyhq.com/anthropic/abc',
    );
    expect(ashby).toMatchObject({ ats: 'ashby', title: 'Research Engineer', company: 'Anthropic' });
  });

  it('returns null when the description is too short', () => {
    const url = 'https://example.com/x';
    const doc = page('<body><h1>Role</h1><p>Hi</p></body>');
    expect(extractPosting(doc, url)).toBeNull();
  });

  it('flags LinkedIn Easy Apply as easyApplyOnly', () => {
    const url = 'https://www.linkedin.com/jobs/view/123';
    const doc = page(
      `<body>
        <h1 class="t-24">Data Scientist</h1>
        <div class="job-details-jobs-unified-top-card__company-name">Acme</div>
        <div id="job-details"><p>${'Analyse product funnels. '.repeat(8)}</p></div>
        <button class="jobs-apply-button" aria-label="Easy Apply">Easy Apply</button>
      </body>`,
    );
    expect(extractPosting(doc, url)?.easyApplyOnly).toBe(true);
  });
});
