import { loadConfig, loadOrCreateToken, type AgentConfig, type Paths } from './config.js';
import { ApolloClient } from './integrations/apollo.js';
import { GmailClient } from './integrations/gmail.js';
import { Llm } from './integrations/llm.js';
import { OutreachEngine } from './pipeline/outreach.js';
import { Runner } from './pipeline/runner.js';
import { Tracker } from './pipeline/tracker.js';
import { JobStore } from './store/jobs.js';
import { OutreachStore } from './store/outreach.js';

/** Everything the daemon and the CLI share. Built once per process. */
export interface App {
  cfg: AgentConfig;
  paths: Paths;
  token: string;
  jobs: JobStore;
  outreachStore: OutreachStore;
  tracker: Tracker;
  llm: Llm;
  apollo: ApolloClient;
  gmail: GmailClient;
  outreach: OutreachEngine;
  runner: Runner;
  applyConfig: (cfg: AgentConfig) => void;
}

export function buildApp(): App {
  const { config, paths } = loadConfig();
  const token = loadOrCreateToken(paths);
  const jobs = new JobStore(paths.jobsFile);
  const outreachStore = new OutreachStore(paths.outreachFile, paths.outreachCsv);
  const tracker = new Tracker(paths.trackerCsv);
  const llm = new Llm(config, paths.repoRoot);
  const apollo = new ApolloClient(process.env.APOLLO_API_KEY);
  const gmail = new GmailClient(paths.gmailCredentialsFile, paths.gmailTokenFile, config.gmail.oauthPort);
  const outreach = new OutreachEngine(config, paths, llm, apollo, gmail, outreachStore);
  const runner = new Runner(config, paths, jobs, tracker, llm, outreach);

  const app: App = {
    cfg: config,
    paths,
    token,
    jobs,
    outreachStore,
    tracker,
    llm,
    apollo,
    gmail,
    outreach,
    runner,
    applyConfig: (next) => {
      app.cfg = next;
      // Components hold a reference to the config object; swap fields in place so they see updates.
      Object.assign(config, next);
    },
  };
  return app;
}
