const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: number = LEVELS[(process.env.AUTOPILOT_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra !== undefined) {
    out.write(`${line} ${safeJson(extra)}\n`);
  } else {
    out.write(`${line}\n`);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => emit('debug', scope, m, x),
    info: (m: string, x?: unknown) => emit('info', scope, m, x),
    warn: (m: string, x?: unknown) => emit('warn', scope, m, x),
    error: (m: string, x?: unknown) => emit('error', scope, m, x),
  };
}

export type Logger = ReturnType<typeof logger>;
