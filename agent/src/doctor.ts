import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig, Paths } from './config.js';
import type { GmailClient } from './integrations/gmail.js';
import { loadProfileContext, profileLooksUnpopulated } from './pipeline/profile.js';
import type { DoctorCheck } from './protocol.js';

function which(bin: string): string | undefined {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function pyModule(mod: string): boolean {
  try {
    execFileSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitRemote(repoRoot: string): string | undefined {
  try {
    return execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

async function githubIsPrivate(remote: string): Promise<boolean | undefined> {
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return undefined;
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'user-agent': 'ai-job-search-autopilot' } });
    if (res.status === 404) return true; // unauthenticated 404 means private (or gone)
    if (!res.ok) return undefined;
    const data = (await res.json()) as { private?: boolean };
    return data.private;
  } catch {
    return undefined;
  }
}

export async function runDoctor(cfg: AgentConfig, paths: Paths, gmail: GmailClient): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, required = true) => checks.push({ name, ok, detail, required });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js >= 22', major >= 22, `running ${process.version}`);

  add('Repo root', fs.existsSync(path.join(paths.repoRoot, 'CLAUDE.md')), paths.repoRoot);

  const profile = loadProfileContext(paths);
  const populated = !profileLooksUnpopulated(profile);
  add('Candidate profile populated (/setup)', populated, populated ? '01-candidate-profile.md and CLAUDE.md carry real data' : 'placeholders found: run `claude` then `/setup` in the repo');

  add('Standing answers (agent/profile/answers.json)', fs.existsSync(paths.answersFile), fs.existsSync(paths.answersFile) ? paths.answersFile : 'copy answers.example.json to answers.json and fill it in');

  const claude = process.env.CLAUDE_CODE_PATH ?? which('claude');
  add(
    'Tailor backend',
    true,
    cfg.llm.backend === 'cursor'
      ? 'Cursor chat runs /autoapply; SpeedyApply is the discovery feed (`npm run cli -- feed`)'
      : claude
        ? `Claude Agent SDK (${claude})`
        : 'Claude binary not in PATH',
    false,
  );

  const lualatex = which('lualatex');
  const xelatex = which('xelatex');
  const typst = which('typst');
  add('LaTeX (lualatex + xelatex)', Boolean(lualatex && xelatex), lualatex && xelatex ? `${lualatex}, ${xelatex}` : 'missing: install MacTeX/BasicTeX (see SETUP.md), or register a Typst template via /add-template', !typst);
  add('Typst (optional alternative)', Boolean(typst), typst ?? 'not installed', false);

  add('pypdf or pdftotext (ATS check)', pyModule('pypdf') || Boolean(which('pdftotext')), pyModule('pypdf') ? 'pypdf' : which('pdftotext') ? 'pdftotext' : 'pip install pypdf', false);
  add('Bun (portal CLIs for /scrape)', Boolean(which('bun')), which('bun') ?? 'not installed (only needed for /scrape)', false);

  add('APOLLO_API_KEY', Boolean(process.env.APOLLO_API_KEY), process.env.APOLLO_API_KEY ? 'set' : 'not set: referral search disabled (agent/.env)', false);
  if (cfg.llm.backend === 'cursor') {
    add('LLM backend', true, 'Cursor runs /autoapply; SpeedyApply is the only discovery feed', false);
  } else {
    const llmBackend = process.env.ANTHROPIC_API_KEY && (cfg.llm.model || process.env.ANTHROPIC_MODEL) ? 'anthropic' : 'agent-sdk';
    add('LLM backend', true, llmBackend === 'anthropic' ? `direct Anthropic API (${cfg.llm.model || process.env.ANTHROPIC_MODEL})` : 'Claude Agent SDK (Claude Code login)', false);
  }

  add('Gmail credentials', gmail.hasCredentials(), gmail.hasCredentials() ? paths.gmailCredentialsFile : 'missing: download a Desktop-app OAuth client JSON to agent/secrets/gmail_credentials.json', false);
  add('Gmail authorized', gmail.isAuthorized(), gmail.isAuthorized() ? `connected${gmail.accountEmail() ? ` as ${gmail.accountEmail()}` : ''}` : 'run `npm run cli -- gmail auth`', false);

  const remote = gitRemote(paths.repoRoot);
  if (remote) {
    const priv = await githubIsPrivate(remote);
    add(
      'Repository is private',
      priv !== false,
      priv === false
        ? `${remote} is PUBLIC. /setup writes your name, contact details and employment history into tracked files. Make it private (or move to a private repo with this one as upstream, SETUP.md section 8) before running /setup or committing.`
        : priv === true
          ? remote
          : `${remote} (visibility unknown)`,
    );
  }

  add('Tracker present', fs.existsSync(paths.trackerCsv), fs.existsSync(paths.trackerCsv) ? paths.trackerCsv : 'will be created on first application', false);
  return checks;
}
