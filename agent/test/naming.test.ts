import { describe, expect, it } from 'vitest';
import { applicationSlug, companyResearchKey, sameName, slugPart, toDomain } from '../src/util/naming.js';

describe('applicationSlug (documents/README.md Subfolder naming rule)', () => {
  it('lowercases, replaces spaces, drops other characters, collapses underscores', () => {
    expect(slugPart('Novo Nordisk A/S')).toBe('novo_nordisk_as');
    expect(applicationSlug('Acme', 'ML Engineer')).toBe('acme_ml_engineer');
    expect(applicationSlug('  Big  Corp ', 'Software Engineer (Backend) - Remote')).toBe('big_corp_software_engineer_backend_remote');
  });
  it('returns an empty string when nothing survives, so callers stop', () => {
    expect(applicationSlug('***', '///')).toBe('');
  });
  it('never yields a path separator', () => {
    expect(applicationSlug('a/b', 'c\\d')).not.toMatch(/[\\/]/);
  });
});

describe('companyResearchKey (04-job-evaluation.md cache filename)', () => {
  it('lowercases, trims, spaces to hyphens, keeps legal suffixes', () => {
    expect(companyResearchKey('  Acme Corp ')).toBe('acme-corp');
    expect(companyResearchKey('Novo Nordisk A/S')).toBe('novo-nordisk-a/s');
  });
});

describe('sameName / toDomain', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(sameName('Acme  Corp', 'acme corp')).toBe(true);
    expect(sameName('Acme', 'Acme Inc')).toBe(false);
  });
  it('extracts a bare domain from URLs and hostnames', () => {
    expect(toDomain('https://www.acme.com/careers?x=1')).toBe('acme.com');
    expect(toDomain('jobs.lever.co')).toBe('jobs.lever.co');
    expect(toDomain('not a url')).toBeUndefined();
    expect(toDomain(undefined)).toBeUndefined();
  });
});
