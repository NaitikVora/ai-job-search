import fs from 'node:fs';
import { FINAL_STATUSES, TRACKER_HEADER, type TrackerRow } from '../protocol.js';
import { parseCsv, toCsvLine } from '../util/csv.js';
import { sameName, todayIso } from '../util/naming.js';

/**
 * job_search_tracker.csv access that follows /apply Step 6b and /outcome Step 3 to the letter:
 * - never restructure or reorder rows, never touch other rows
 * - match case-insensitively on company + role; a row is "open" unless its status is Final
 * - moving a row off `drafted` overwrites `date` with the real submission date
 * - a header missing `,deadline` gets it appended to the header line only
 */
export class Tracker {
  constructor(private readonly file: string) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  private readRaw(): { header: string[]; rows: string[][] } {
    if (!fs.existsSync(this.file)) return { header: [...TRACKER_HEADER], rows: [] };
    const parsed = parseCsv(fs.readFileSync(this.file, 'utf8'));
    const header = parsed[0] ?? [...TRACKER_HEADER];
    const rows = parsed.slice(1).filter((r) => r.some((c) => c.trim() !== ''));
    if (header.at(-1) !== 'deadline') header.push('deadline');
    return { header, rows };
  }

  private writeRaw(header: string[], rows: string[][]): void {
    const lines = [toCsvLine(header), ...rows.map((r) => toCsvLine(padRow(r, header.length)))];
    fs.writeFileSync(this.file, lines.join('\n') + '\n');
  }

  list(): TrackerRow[] {
    const { header, rows } = this.readRaw();
    return rows.map((r) => rowToRecord(header, r));
  }

  /** The open (non-final) row for this company + role, with its index, if any. */
  findOpen(company: string, role: string): { index: number; row: TrackerRow } | undefined {
    const { header, rows } = this.readRaw();
    const ci = header.indexOf('company');
    const ri = header.indexOf('role');
    const si = header.indexOf('status');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!sameName(r[ci] ?? '', company) || !sameName(r[ri] ?? '', role)) continue;
      const status = (r[si] ?? '').trim().toLowerCase();
      if (FINAL_STATUSES.has(status)) continue;
      return { index: i, row: rowToRecord(header, r) };
    }
    return undefined;
  }

  /**
   * Mark the open row for company+role as applied (called after the form was submitted).
   * If /autoapply did not write a `drafted` row (unexpected), append one directly as `applied`.
   */
  markApplied(input: {
    company: string;
    role: string;
    submittedAt?: Date;
    note?: string;
    fitRating?: number;
    cvFile?: string;
    coverLetterFile?: string;
    source?: string;
    deadline?: string | null;
    channel?: string;
  }): { action: 'updated' | 'appended'; row: TrackerRow } {
    const { header, rows } = this.readRaw();
    const date = todayIso(input.submittedAt ?? new Date());
    const idx = (col: string) => header.indexOf(col);
    const existing = this.findOpen(input.company, input.role);
    const noteText = input.note ?? `applied ${date} via autopilot`;

    if (existing) {
      const r = padRow(rows[existing.index]!, header.length);
      const status = (r[idx('status')] ?? '').trim().toLowerCase();
      // Never move a row backwards: only drafted (or empty) advances to applied.
      if (status === '' || status === 'drafted') {
        r[idx('status')] = 'applied';
        r[idx('date')] = date;
      }
      const notes = r[idx('notes')] ?? '';
      r[idx('notes')] = notes ? `${notes}; ${noteText}` : noteText;
      if (input.cvFile) r[idx('cv_file')] = input.cvFile;
      if (input.coverLetterFile) r[idx('cover_letter_file')] = input.coverLetterFile;
      if (input.source && !(r[idx('source')] ?? '').trim()) r[idx('source')] = input.source;
      rows[existing.index] = r;
      this.writeRaw(header, rows);
      return { action: 'updated', row: rowToRecord(header, r) };
    }

    const fresh: TrackerRow = {
      date,
      company: input.company,
      sector: '',
      role: input.role,
      role_type: '',
      channel: input.channel ?? '',
      status: 'applied',
      contact_person: '',
      fit_rating: input.fitRating !== undefined ? String(Math.round(input.fitRating)) : '',
      notes: noteText,
      cv_file: input.cvFile ?? '',
      cover_letter_file: input.coverLetterFile ?? '',
      source: input.source ?? '',
      deadline: input.deadline ?? '',
    };
    const line = header.map((h) => (fresh as Record<string, string>)[h] ?? '');
    rows.push(line);
    this.writeRaw(header, rows);
    return { action: 'appended', row: fresh };
  }

  /** Companies + roles with an open or applied row (used to skip duplicates before tailoring). */
  hasAnyRow(company: string, role: string): boolean {
    return this.list().some((r) => sameName(r.company, company) && sameName(r.role, role));
  }
}

function padRow(row: string[], len: number): string[] {
  const out = [...row];
  while (out.length < len) out.push('');
  return out;
}

function rowToRecord(header: string[], row: string[]): TrackerRow {
  const rec: Record<string, string> = {};
  for (const col of TRACKER_HEADER) rec[col] = '';
  header.forEach((h, i) => {
    rec[h] = row[i] ?? '';
  });
  return rec as TrackerRow;
}
