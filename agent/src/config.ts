import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PublicConfig } from './protocol.js';

export const AGENT_VERSION = '0.1.0';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `agent/` regardless of whether we run from `src/` (tsx) or `dist/` (tsc). */
export const AGENT_DIR = path.resolve(here, '..');

const ConfigSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(47831),
  /** Repo root, relative to agent/ unless absolute. */
  repoRoot: z.string().default('..'),
  autopilot: z
    .object({
      enabled: z.boolean().default(true),
      /** Click submit automatically when every gate passes. */
      autoSubmit: z.boolean().default(true),
      /** fit_rating (0-100) below which /autoapply stops after the evaluation. 60 = "Good Fit" per 04-job-evaluation.md. */
      minFitToApply: z.number().min(0).max(100).default(60),
      /** Per-field mapping confidence below which the field blocks auto-submit. */
      minFieldConfidence: z.number().min(0).max(1).default(0.8),
      maxApplicationsPerDay: z.number().int().min(0).default(15),
      /** Hard stop for a single /autoapply run (Agent SDK client-side estimate). */
      maxBudgetUsdPerApplication: z.number().min(0).default(4),
      /** Hard stop for the agentic loop of a single /autoapply run. */
      maxTurnsPerApplication: z.number().int().min(10).default(160),
      /** Never auto-submit on these ATS kinds (adapter still fills; human submits). */
      reviewOnlyAts: z.array(z.string()).default([]),
    })
    .prefault({}),
  outreach: z
    .object({
      mode: z.enum(['auto', 'approve', 'off']).default('auto'),
      /** People to enrich + contact per company. Each enriched person costs 1 Apollo credit. */
      peoplePerCompany: z.number().int().min(0).max(25).default(10),
      maxEmailsPerDay: z.number().int().min(0).default(20),
      maxEmailsPerCompany: z.number().int().min(0).default(10),
      /** Do not contact the same company again within this many days. */
      cooldownDaysPerCompany: z.number().int().min(0).default(30),
      followUpAfterDays: z.number().int().min(0).default(7),
      maxFollowUps: z.number().int().min(0).max(2).default(1),
      attachCv: z.boolean().default(true),
      /** Only enrich people whose Apollo record says an email exists (saves credits). */
      requireHasEmail: z.boolean().default(true),
      /** Titles searched in addition to the role-derived ones. */
      extraTitles: z.array(z.string()).default(['Talent Acquisition', 'Recruiter', 'Technical Recruiter']),
    })
    .prefault({}),
  llm: z
    .object({
      /** `auto`: direct Anthropic API when ANTHROPIC_API_KEY is set, else the Agent SDK (Claude Code login). */
      backend: z.enum(['auto', 'anthropic', 'agent-sdk']).default('auto'),
      /** Model id for the direct Anthropic backend. Leave empty to use the SDK default. */
      model: z.string().default(''),
    })
    .prefault({}),
  gmail: z
    .object({
      /** Loopback port for the OAuth redirect. */
      oauthPort: z.number().int().default(47832),
      fromName: z.string().default(''),
    })
    .prefault({}),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export interface Paths {
  agentDir: string;
  repoRoot: string;
  configFile: string;
  stateDir: string;
  secretsDir: string;
  tokenFile: string;
  jobsFile: string;
  outreachFile: string;
  answersFile: string;
  gmailCredentialsFile: string;
  gmailTokenFile: string;
  trackerCsv: string;
  outreachCsv: string;
  applicationsDir: string;
  companyResearchDir: string;
  skillDir: string;
}

export function resolvePaths(cfg: AgentConfig): Paths {
  const repoRoot = path.isAbsolute(cfg.repoRoot) ? cfg.repoRoot : path.resolve(AGENT_DIR, cfg.repoRoot);
  const stateDir = path.join(AGENT_DIR, 'state');
  const secretsDir = path.join(AGENT_DIR, 'secrets');
  return {
    agentDir: AGENT_DIR,
    repoRoot,
    configFile: path.join(AGENT_DIR, 'config.json'),
    stateDir,
    secretsDir,
    tokenFile: path.join(stateDir, 'token.txt'),
    jobsFile: path.join(stateDir, 'jobs.json'),
    outreachFile: path.join(stateDir, 'outreach.json'),
    answersFile: path.join(AGENT_DIR, 'profile', 'answers.json'),
    gmailCredentialsFile: path.join(secretsDir, 'gmail_credentials.json'),
    gmailTokenFile: path.join(secretsDir, 'gmail_token.json'),
    trackerCsv: path.join(repoRoot, 'job_search_tracker.csv'),
    outreachCsv: path.join(repoRoot, 'outreach', 'outreach_log.csv'),
    applicationsDir: path.join(repoRoot, 'documents', 'applications'),
    companyResearchDir: path.join(repoRoot, 'company_research'),
    skillDir: path.join(repoRoot, '.claude', 'skills', 'job-application-assistant'),
  };
}

/** Minimal .env loader (no dependency): KEY=value lines, `#` comments, optional quotes. Never overrides existing env. */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(): { config: AgentConfig; paths: Paths } {
  loadDotEnv(path.join(AGENT_DIR, '.env'));
  const configFile = path.join(AGENT_DIR, 'config.json');
  let raw: unknown = {};
  if (fs.existsSync(configFile)) {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } else {
    const example = path.join(AGENT_DIR, 'config.example.json');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, configFile);
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  }
  const config = ConfigSchema.parse(raw);
  const paths = resolvePaths(config);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.secretsDir, { recursive: true });
  return { config, paths };
}

export function saveConfig(paths: Paths, config: AgentConfig): void {
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n');
}

/** Merge a partial update (from the extension settings UI) and re-validate. */
export function mergeConfig(current: AgentConfig, patch: unknown): AgentConfig {
  const p = (patch ?? {}) as Record<string, unknown>;
  const merged = {
    ...current,
    ...p,
    autopilot: { ...current.autopilot, ...((p.autopilot as object) ?? {}) },
    outreach: { ...current.outreach, ...((p.outreach as object) ?? {}) },
    llm: { ...current.llm, ...((p.llm as object) ?? {}) },
    gmail: { ...current.gmail, ...((p.gmail as object) ?? {}) },
  };
  return ConfigSchema.parse(merged);
}

export function toPublicConfig(cfg: AgentConfig, paths: Paths): PublicConfig {
  return {
    autopilot: {
      enabled: cfg.autopilot.enabled,
      autoSubmit: cfg.autopilot.autoSubmit,
      minFitToApply: cfg.autopilot.minFitToApply,
      minFieldConfidence: cfg.autopilot.minFieldConfidence,
      maxApplicationsPerDay: cfg.autopilot.maxApplicationsPerDay,
    },
    outreach: {
      mode: cfg.outreach.mode,
      peoplePerCompany: cfg.outreach.peoplePerCompany,
      maxEmailsPerDay: cfg.outreach.maxEmailsPerDay,
    },
    repoRoot: paths.repoRoot,
    version: AGENT_VERSION,
  };
}

/** The bearer token the extension must present. Generated once, printed at startup. */
export function loadOrCreateToken(paths: Paths): string {
  const fromEnv = process.env.AUTOPILOT_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (fs.existsSync(paths.tokenFile)) {
    const t = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    if (t.length >= 16) return t;
  }
  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(paths.tokenFile, token + '\n', { mode: 0o600 });
  return token;
}
