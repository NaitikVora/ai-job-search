import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tracker } from '../src/pipeline/tracker.js';
import { TRACKER_HEADER } from '../src/protocol.js';
import { parseCsv, toCsvLine } from '../src/util/csv.js';

describe('csv', () => {
  it('round-trips quoted fields with commas, quotes and newlines', () => {
    const line = toCsvLine(['a', 'b,c', 'he said "hi"', 'multi\nline', '']);
    expect(parseCsv(line)).toEqual([['a', 'b,c', 'he said "hi"', 'multi\nline', '']]);
  });
  it('handles CRLF and a BOM', () => {
    expect(parseCsv('\ufeffx,y\r\n1,2\r\n')).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
  });
});

describe('Tracker', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
    file = path.join(dir, 'job_search_tracker.csv');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('moves a drafted row to applied and overwrites the date (per /outcome)', () => {
    fs.writeFileSync(
      file,
      [
        TRACKER_HEADER.join(','),
        '2026-09-01,Acme,,ML Engineer,,online,drafted,,72,,cv/main_acme_ml_engineer.tex,cover_letters/cover_acme_ml_engineer.tex,https://x/1,2026-10-01',
        '2026-08-01,Other,,Role,,portal,applied,,50,,cv/a.tex,cover_letters/b.tex,https://x/2,',
      ].join('\n') + '\n',
    );
    const t = new Tracker(file);
    const r = t.markApplied({ company: 'acme', role: 'ml engineer', submittedAt: new Date('2026-09-09T12:00:00Z') });
    expect(r.action).toBe('updated');
    const rows = t.list();
    expect(rows[0]!.status).toBe('applied');
    expect(rows[0]!.date).toBe('2026-09-09');
    expect(rows[0]!.deadline).toBe('2026-10-01'); // untouched
    expect(rows[0]!.notes).toContain('applied 2026-09-09 via autopilot');
    expect(rows[1]).toMatchObject({ company: 'Other', status: 'applied', date: '2026-08-01' }); // other rows untouched
  });

  it('never moves an open row backwards and skips final rows when matching', () => {
    fs.writeFileSync(
      file,
      [TRACKER_HEADER.join(','), '2026-08-01,Acme,,ML Engineer,,online,rejected,,72,,,,https://x/1,', '2026-09-01,Acme,,ML Engineer,,online,interview,,72,,,,https://x/3,'].join('\n') + '\n',
    );
    const t = new Tracker(file);
    const r = t.markApplied({ company: 'Acme', role: 'ML Engineer' });
    expect(r.action).toBe('updated');
    const rows = t.list();
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[1]!.status).toBe('interview'); // not downgraded to applied
    expect(rows[1]!.notes).toContain('via autopilot');
  });

  it('appends an applied row when nothing matches, and creates the file with the canonical header', () => {
    const t = new Tracker(file);
    const r = t.markApplied({ company: 'New Co', role: 'Data Scientist', fitRating: 81.4, source: 'https://x/9', deadline: '2026-12-01' });
    expect(r.action).toBe('appended');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe(TRACKER_HEADER.join(','));
    expect(t.list()[0]).toMatchObject({ company: 'New Co', status: 'applied', fit_rating: '81', deadline: '2026-12-01' });
  });

  it('appends ,deadline to a legacy header without touching data rows', () => {
    fs.writeFileSync(file, 'date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n2026-01-01,A,,B,,,drafted,,,,,,\n');
    const t = new Tracker(file);
    t.markApplied({ company: 'A', role: 'B' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]!.endsWith(',deadline')).toBe(true);
    expect(parseCsv(lines[1]!)[0]!.length).toBe(14);
  });
});
