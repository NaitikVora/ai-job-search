import { describe, expect, it } from 'vitest';
import {
  canonicalJobUrl,
  enqueueNextUnseen,
  githubRawUrl,
  mergeFeedEntries,
  parseAgeHours,
  parseSpeedyApplyMarkdown,
  stopPendingFeed,
} from '../src/feed';

const FEED = `
### FAANG+

| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://amazon.com"><strong>Amazon</strong></a> | Older Role | Seattle, WA | $180k/yr | <a href="https://amazon.jobs/jobs/2/apply?utm_source=foo"><img alt="Apply"/></a> | 4d |
| <a href="https://adobe.com"><strong>Adobe</strong></a> | Newest Role | San Jose, CA | $170k/yr | <a href="https://adobe.example/jobs/1"><img alt="Apply"/></a> | 3h |

### Quant

| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://jane.com"><strong>Jane Street</strong></a> | Quant Dev | New York, NY | $250k/yr | <a href="https://jane.example/jobs/q1"><img alt="Apply"/></a> | 1d |
| <a href="https://jane.com"><strong>Jane Street</strong></a> | Duplicate | New York, NY | $250k/yr | <a href="https://jane.example/jobs/q1?utm_campaign=x"><img alt="Apply"/></a> | 2d |

### Other

| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://small.example"><strong>Small &amp; Co</strong></a> | SWE <br> New Grad | Remote | <a href="https://small.example/jobs/9"><img alt="Apply"/></a> | 1d |
`;

describe('githubRawUrl', () => {
  it('converts a GitHub blob link into the raw file URL', () => {
    expect(
      githubRawUrl(
        'https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md',
      ),
    ).toBe(
      'https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md',
    );
  });

  it('passes other HTTPS sources through and rejects insecure URLs', () => {
    expect(githubRawUrl('https://example.com/feed.md')).toBe('https://example.com/feed.md');
    expect(() => githubRawUrl('http://example.com/feed.md')).toThrow(/HTTPS/);
  });
});

describe('parseSpeedyApplyMarkdown', () => {
  it('parses rows and sorts newest first with source-order tie breaking', () => {
    const entries = parseSpeedyApplyMarkdown(FEED);
    expect(entries.map((entry) => entry.title)).toEqual([
      'Newest Role',
      'Quant Dev',
      'SWE / New Grad',
      'Older Role',
    ]);
    expect(entries[0]).toMatchObject({
      company: 'Adobe',
      location: 'San Jose, CA',
      salary: '$170k/yr',
      ageLabel: '3h',
      ageHours: 3,
      section: 'FAANG+',
      status: 'unseen',
    });
    expect(entries[1]?.section).toBe('Quant');
    expect(entries[2]?.company).toBe('Small & Co');
  });

  it('deduplicates tracking variants of the same job URL', () => {
    const entries = parseSpeedyApplyMarkdown(FEED);
    expect(entries.filter((entry) => entry.company === 'Jane Street')).toHaveLength(1);
  });

  it('preserves local progress when the feed refreshes', () => {
    const old = parseSpeedyApplyMarkdown(FEED);
    old[0]!.status = 'review';
    old[0]!.tabId = 17;
    const fresh = parseSpeedyApplyMarkdown(FEED.replace('| 3h |', '| 1d |'));
    const merged = mergeFeedEntries(fresh, old);
    const adobe = merged.find((entry) => entry.company === 'Adobe');
    expect(adobe).toMatchObject({ status: 'review', tabId: 17, ageLabel: '1d' });
  });
});

describe('age and URL normalisation', () => {
  it('supports hours, days, weeks, months, years and unknown values', () => {
    expect(parseAgeHours('3h')).toBe(3);
    expect(parseAgeHours('2d')).toBe(48);
    expect(parseAgeHours('1wk')).toBe(168);
    expect(parseAgeHours('2mo')).toBe(1440);
    expect(parseAgeHours('1yr')).toBe(8760);
    expect(parseAgeHours('today')).toBe(0);
    expect(parseAgeHours('?')).toBe(Number.POSITIVE_INFINITY);
  });

  it('removes tracking parameters but retains job selectors', () => {
    expect(canonicalJobUrl('https://x.test/jobs?gh_jid=9&utm_source=repo#apply')).toBe(
      'https://x.test/jobs?gh_jid=9',
    );
  });
});

describe('review queue orchestration', () => {
  it('queues unseen jobs latest-first and skips completed jobs', () => {
    const feed = {
      sourceUrl: 'https://example.com/feed.md',
      rawUrl: 'https://example.com/feed.md',
      entries: parseSpeedyApplyMarkdown(FEED),
      queue: [],
      running: false,
    };
    feed.entries[0]!.status = 'review';
    const queued = enqueueNextUnseen(feed, 2);
    expect(queued.queue).toEqual([feed.entries[1]!.id, feed.entries[2]!.id]);
    expect(queued.entries.map((entry) => entry.status)).toEqual([
      'review',
      'queued',
      'queued',
      'unseen',
    ]);
    expect(queued.running).toBe(true);
    expect(feed.entries[1]!.status).toBe('unseen');
  });

  it('caps a batch at 50 and returns unopened jobs when stopped', () => {
    const original = parseSpeedyApplyMarkdown(FEED)[0]!;
    const feed = {
      sourceUrl: 'https://example.com/feed.md',
      rawUrl: 'https://example.com/feed.md',
      entries: Array.from({ length: 60 }, (_, index) => ({
        ...original,
        id: `${original.id}-${index}`,
        url: `${original.url}/${index}`,
        sourceOrder: index,
      })),
      queue: [],
      running: false,
    };
    const queued = enqueueNextUnseen(feed, 999);
    expect(queued.queue).toHaveLength(50);
    const stopped = stopPendingFeed(queued);
    expect(stopped.queue).toEqual([]);
    expect(stopped.running).toBe(false);
    expect(stopped.entries.every((entry) => entry.status === 'unseen')).toBe(true);
  });
});
