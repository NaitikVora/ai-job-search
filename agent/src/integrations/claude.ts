import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../log.js';

const log = logger('claude');

/**
 * Bash commands the headless agent may run without a human. Everything else is denied.
 *
 * The job posting is untrusted input that flows straight into the agent's context, so a
 * prompt-injected "run this command" must hit a wall here. The list mirrors what
 * /apply legitimately needs: compile (lualatex/xelatex/latexmk/typst), verify
 * (python tools/verify_pdf.py, pdftotext), salary lookup, portal CLIs (bun run),
 * the curl fallback from 09-web-research.md, and read-only shell utilities.
 */
const BASH_ALLOW_PREFIXES = [
  'lualatex ',
  'xelatex ',
  'pdflatex ',
  'latexmk ',
  'typst ',
  'python tools/verify_pdf.py',
  'python3 tools/verify_pdf.py',
  'python salary_lookup.py',
  'python3 salary_lookup.py',
  'pdftotext ',
  'bun run ',
  'curl ',
  'ls',
  'cat ',
  'wc ',
  'head ',
  'tail ',
  'mkdir ',
  'pwd',
  'echo ',
  'date',
  'test ',
  'python3 -c ',
  'python -c ',
];

/** `rm` is allowed only for build artifacts inside cv/ or cover_letters/ (Step 5e cleanup). */
const RM_ARTIFACT_RE =
  /^rm\s+(-f\s+)?((cv|cover_letters)\/[A-Za-z0-9_.\-]+\.(aux|log|out|txt|fls|fdb_latexmk|synctex\.gz|toc|bbl|blg)\s*)+$/;

const DANGEROUS_RE = /(\$\(|`|>\s*\/|\|\s*(sh|bash|zsh)\b|sudo\b|chmod\b|chown\b|curl[^|]*\|\s*(sh|bash)|\bgit\s+push\b|\brm\s+-rf?\s+\/)/;

export function bashCommandAllowed(command: string): { ok: boolean; reason: string } {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: 'empty command' };
  if (DANGEROUS_RE.test(cmd)) return { ok: false, reason: 'command contains a blocked construct' };
  // Allow `cd cv && lualatex ...` style chains as long as every segment is allowed.
  const segments = cmd.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
  for (const seg of segments) {
    const s = seg.trim();
    if (/^cd\s+[A-Za-z0-9_./\-]+$/.test(s)) continue;
    if (RM_ARTIFACT_RE.test(s)) continue;
    if (s.includes('|')) {
      // pipes only between allowed read-only commands (e.g. `pdftotext ... | head`)
      const parts = s.split('|').map((p) => p.trim());
      if (!parts.every((p) => BASH_ALLOW_PREFIXES.some((pre) => p === pre.trim() || p.startsWith(pre)))) {
        return { ok: false, reason: `pipeline segment not allowlisted: ${s}` };
      }
      continue;
    }
    if (!BASH_ALLOW_PREFIXES.some((pre) => s === pre.trim() || s.startsWith(pre))) {
      return { ok: false, reason: `command not allowlisted: ${s}` };
    }
  }
  return { ok: true, reason: 'allowlisted' };
}

export interface RunAgentOptions {
  cwd: string;
  prompt: string;
  /** JSON schema for structured output; the result's `structured_output` is returned as `output`. */
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Extra instructions appended to the Claude Code system prompt. */
  systemAppend?: string;
  /** Called for every message for progress reporting. */
  onMessage?: (m: SDKMessage) => void;
  abort?: AbortController;
  /** `true` (default) loads CLAUDE.md, skills and commands from the repo. */
  projectSettings?: boolean;
  /** When false, no tools at all (pure structured generation). */
  tools?: boolean;
}

export interface RunAgentResult {
  ok: boolean;
  text: string;
  output?: unknown;
  costUsd: number;
  turns: number;
  sessionId?: string;
  error?: string;
  denials: string[];
}

function resolveClaudeExecutable(): string | undefined {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;
  try {
    const p = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

/** Run one headless Claude Agent SDK session inside the repo. */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const denials: string[] = [];
  const projectSettings = opts.projectSettings !== false;
  const useTools = opts.tools !== false;

  const options: Options = {
    cwd: opts.cwd,
    settingSources: projectSettings ? ['project'] : [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemAppend },
    permissionMode: 'acceptEdits',
    allowedTools: useTools
      ? ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'TodoWrite']
      : [],
    disallowedTools: useTools
      ? ['AskUserQuestion', 'NotebookEdit', 'Bash(git push*)', 'Bash(sudo *)', 'Bash(rm -rf *)']
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill'],
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    abortController: opts.abort,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-job-search-autopilot' },
    canUseTool: async (toolName, input) => {
      if (toolName === 'Bash') {
        const command = String((input as { command?: unknown }).command ?? '');
        const verdict = bashCommandAllowed(command);
        if (verdict.ok) return { behavior: 'allow', updatedInput: input };
        denials.push(`Bash: ${command} (${verdict.reason})`);
        log.warn('denied Bash command', { command, reason: verdict.reason });
        return {
          behavior: 'deny',
          message: `Autopilot policy: ${verdict.reason}. Only compile/verify/lookup commands are permitted in headless mode.`,
        };
      }
      if (toolName === 'AskUserQuestion') {
        denials.push('AskUserQuestion');
        return {
          behavior: 'deny',
          message: 'Headless mode: nobody can answer. Decide using the profile and the /autoapply rules, and continue.',
        };
      }
      // Edits/reads inside the repo are covered by acceptEdits; anything else that falls through is denied.
      denials.push(`${toolName}`);
      return { behavior: 'deny', message: `Autopilot policy: tool ${toolName} is not available in headless mode.` };
    },
  };
  if (opts.outputSchema) options.outputFormat = { type: 'json_schema', schema: opts.outputSchema };
  const exe = resolveClaudeExecutable();
  if (exe) options.pathToClaudeCodeExecutable = exe;

  let text = '';
  let output: unknown;
  let costUsd = 0;
  let turns = 0;
  let sessionId: string | undefined;
  let ok = false;
  let error: string | undefined;

  try {
    for await (const message of query({ prompt: opts.prompt, options })) {
      opts.onMessage?.(message);
      if (message.type === 'result') {
        costUsd = message.total_cost_usd ?? 0;
        turns = message.num_turns ?? 0;
        sessionId = message.session_id;
        if (message.subtype === 'success') {
          ok = !message.is_error;
          text = message.result ?? '';
          output = message.structured_output;
          if (message.is_error) error = text || 'agent reported an error';
        } else {
          error = `${message.subtype}: ${(message as { errors?: string[] }).errors?.join('; ') ?? ''}`.trim();
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error('agent run threw', { error, cwd: opts.cwd, exe: exe ?? path.basename('bundled') });
  }
  return { ok, text, output, costUsd, turns, sessionId, error, denials };
}

/** Summarise an SDK message for the job log without dumping full tool payloads. */
export function describeMessage(m: SDKMessage): string | undefined {
  if (m.type === 'assistant') {
    const content = (m as { message?: { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> } }).message?.content ?? [];
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const input = block.input ?? {};
        const hint =
          typeof input.file_path === 'string'
            ? path.basename(input.file_path)
            : typeof input.command === 'string'
              ? input.command.slice(0, 80)
              : typeof input.url === 'string'
                ? input.url.slice(0, 80)
                : typeof input.query === 'string'
                  ? input.query.slice(0, 60)
                  : typeof input.description === 'string'
                    ? input.description.slice(0, 60)
                    : '';
        parts.push(`${block.name}${hint ? `(${hint})` : ''}`);
      } else if (block.type === 'text' && block.text) {
        const t = block.text.trim().replace(/\s+/g, ' ');
        if (t) parts.push(t.length > 160 ? `${t.slice(0, 157)}...` : t);
      }
    }
    return parts.length ? parts.join(' | ') : undefined;
  }
  if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') return 'agent session started';
  return undefined;
}
