import fs from 'node:fs';
import path from 'node:path';

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-ish write: write to a temp file in the same directory, then rename. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a repo-relative path and refuse anything that escapes the repo root. */
export function safeRepoPath(repoRoot: string, rel: string): string {
  const abs = path.resolve(repoRoot, rel);
  const root = path.resolve(repoRoot) + path.sep;
  if (!abs.startsWith(root)) throw new Error(`path escapes repo root: ${rel}`);
  return abs;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
