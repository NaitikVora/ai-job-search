#!/usr/bin/env node
/**
 * autopilot CLI - the same engine as the daemon, callable from a terminal or from
 * Claude Code commands (/outreach).
 *
 *   npm run cli -- doctor
 *   npm run cli -- token
 *   npm run cli -- gmail auth
 *   npm run cli -- outreach --company "Acme" --role "ML Engineer" [--domain acme.com] [--people 10] [--send]
 *   npm run cli -- outreach send-pending
 *   npm run cli -- outreach send --id <target id>
 *   npm run cli -- outreach skip --id <target id>
 *   npm run cli -- outreach follow-ups
 *   npm run cli -- outreach list
 *   npm run cli -- jobs
 *   npm run cli -- feed [--count N] [--all] [--url <blob>] [--write-postings]
 */
import { buildApp } from './app.js';
import { runDoctor } from './doctor.js';
import { writePostingFile } from './pipeline/tailor.js';
import {
  DEFAULT_SPEEDYAPPLY_FEED,
  fetchSpeedyApplyFeed,
  isEligibleSpeedyApplyJob,
  speedyJobToPosting,
} from './pipeline/speedyapply.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<number> {
  const [, , cmd, sub] = process.argv;
  const app = buildApp();

  switch (cmd) {
    case 'doctor': {
      const checks = await runDoctor(app.cfg, app.paths, app.gmail);
      let failed = 0;
      for (const c of checks) {
        const mark = c.ok ? 'OK  ' : c.required ? 'FAIL' : 'WARN';
        if (!c.ok && c.required) failed++;
        console.log(`${mark}  ${c.name}: ${c.detail}`);
      }
      console.log(failed ? `\n${failed} required check(s) failing.` : '\nAll required checks pass.');
      return failed ? 1 : 0;
    }
    case 'token':
      console.log(app.token);
      return 0;
    case 'gmail': {
      if (sub === 'auth') {
        const { url, done } = app.gmail.authorize();
        console.log('Open this URL in your browser to connect Gmail:\n\n' + url + '\n');
        const email = await done;
        console.log(`Connected${email ? ` as ${email}` : ''}.`);
        return 0;
      }
      console.log(JSON.stringify({ hasCredentials: app.gmail.hasCredentials(), authorized: app.gmail.isAuthorized(), email: app.gmail.accountEmail() }, null, 2));
      return 0;
    }
    case 'outreach': {
      if (sub === 'list') {
        for (const t of app.outreachStore.list()) {
          console.log(`${t.createdAt.slice(0, 10)}  ${t.status.padEnd(11)} ${t.company} | ${t.name} (${t.title}) ${t.email ?? '-'} ${t.linkedinUrl ?? ''}`);
        }
        return 0;
      }
      if (sub === 'send-pending') {
        console.log(JSON.stringify(await app.outreach.sendPending(), null, 2));
        return 0;
      }
      if (sub === 'follow-ups') {
        console.log(JSON.stringify(await app.outreach.processFollowUps(), null, 2));
        return 0;
      }
      if (sub === 'send') {
        const id = arg('--id');
        if (!id) {
          console.error('usage: outreach send --id <target id>');
          return 2;
        }
        console.log(JSON.stringify(await app.outreach.sendOne(id), null, 2));
        return 0;
      }
      if (sub === 'skip') {
        const id = arg('--id');
        if (!id) {
          console.error('usage: outreach skip --id <target id>');
          return 2;
        }
        console.log(JSON.stringify(app.outreachStore.update(id, { status: 'skipped' }), null, 2));
        return 0;
      }
      const company = arg('--company');
      const role = arg('--role');
      if (!company || !role) {
        console.error('usage: outreach --company <name> --role <title> [--domain <domain>] [--people N] [--send]');
        return 2;
      }
      if (has('--send')) app.cfg.outreach.mode = 'auto';
      else if (app.cfg.outreach.mode === 'auto') app.cfg.outreach.mode = 'approve';
      const summary = await app.outreach.run({
        company,
        role,
        companyDomain: arg('--domain'),
        people: arg('--people') ? Number(arg('--people')) : undefined,
        postingSummary: arg('--summary'),
        postingUrl: arg('--url'),
      });
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    case 'jobs': {
      for (const j of app.jobs.list()) {
        console.log(`${j.createdAt.slice(0, 16)}  ${j.state.padEnd(12)} ${j.posting.company} | ${j.posting.title}  fit=${j.fit?.overall ?? '-'}  ${j.posting.url}`);
      }
      return 0;
    }
    case 'feed': {
      const source = arg('--url') || DEFAULT_SPEEDYAPPLY_FEED;
      const count = arg('--count') ? Number(arg('--count')) : 10;
      const jobs = await fetchSpeedyApplyFeed(source);
      const eligible = has('--all') ? jobs : jobs.filter(isEligibleSpeedyApplyJob);
      const shown = eligible.slice(0, Math.max(1, Math.min(50, count)));
      console.log(
        `${jobs.length} rows · ${eligible.length} eligible · showing ${shown.length} newest from ${source}`,
      );
      for (const job of shown) {
        console.log(`${job.ageLabel.padStart(4)}  ${job.section.padEnd(7)}  ${job.company} | ${job.title}  ${job.location}`);
        console.log(`      ${job.url}`);
      }
      if (has('--write-postings')) {
        for (const job of shown) {
          const rel = writePostingFile(app.paths, speedyJobToPosting(job));
          console.log(`wrote ${rel}`);
        }
      }
      return 0;
    }
    default:
      console.log('commands: doctor | token | gmail [auth] | outreach (...) | jobs | feed [--count N] [--all] [--url <blob>] [--write-postings]');
      return cmd ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
