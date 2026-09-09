import { buildApp } from './app.js';
import { AGENT_VERSION } from './config.js';
import { logger } from './log.js';
import { startServer } from './server.js';

const log = logger('daemon');

const app = buildApp();

startServer({
  cfg: app.cfg,
  paths: app.paths,
  token: app.token,
  jobs: app.jobs,
  outreachStore: app.outreachStore,
  runner: app.runner,
  outreach: app.outreach,
  tracker: app.tracker,
  gmail: app.gmail,
  onConfigChange: app.applyConfig,
});

// Follow-ups and the approve-queue sender loop run hourly.
const HOUR = 60 * 60 * 1000;
setInterval(() => {
  app.outreach
    .processFollowUps()
    .then((r) => {
      if (r.replied || r.followedUp) log.info('follow-up pass', r);
    })
    .catch((err) => log.warn('follow-up pass failed', { err: String(err) }));
  if (app.cfg.outreach.mode === 'auto') {
    app.outreach.sendPending().catch((err) => log.warn('send-pending failed', { err: String(err) }));
  }
}, HOUR).unref();

log.info(`ai-job-search autopilot daemon v${AGENT_VERSION}`);
log.info(`repo root: ${app.paths.repoRoot}`);
log.info(`pairing token (paste into the extension's Settings): ${app.token}`);
log.info(`autopilot: enabled=${app.cfg.autopilot.enabled} autoSubmit=${app.cfg.autopilot.autoSubmit} minFit=${app.cfg.autopilot.minFitToApply}; outreach mode=${app.cfg.outreach.mode}`);
