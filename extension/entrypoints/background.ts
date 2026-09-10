import type { ApplicationJob, DaemonEvent, JobPosting, OutreachTarget, PublicConfig, TrackerRow } from '@protocol';
import { bytesToBase64, DaemonClient } from '../src/client';
import { onMessage, sendMessage, type FilePayload } from '../src/messaging';
import { DEFAULT_DAEMON, loadPairing, savePairing } from '../src/storage';

interface State {
  connected: boolean;
  config?: PublicConfig;
  jobs: ApplicationJob[];
  outreach: OutreachTarget[];
  tracker: TrackerRow[];
  error?: string;
}

const state: State = { connected: false, jobs: [], outreach: [], tracker: [] };
const filling = new Set<string>();
let client: DaemonClient | undefined;
let ws: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function upsertJob(job: ApplicationJob): void {
  const i = state.jobs.findIndex((j) => j.id === job.id);
  if (i === -1) state.jobs.unshift(job);
  else state.jobs[i] = job;
}

function upsertOutreach(t: OutreachTarget): void {
  const i = state.outreach.findIndex((x) => x.id === t.id);
  if (i === -1) state.outreach.unshift(t);
  else state.outreach[i] = t;
}

async function refreshLists(): Promise<void> {
  if (!client) return;
  try {
    const [jobs, outreach, tracker, config] = await Promise.all([
      client.listJobs(),
      client.outreach(),
      client.tracker(),
      client.config(),
    ]);
    state.jobs = jobs.jobs;
    state.outreach = outreach.targets;
    state.tracker = tracker.rows;
    state.config = config;
    state.connected = true;
    state.error = undefined;
  } catch (err) {
    state.connected = false;
    state.error = err instanceof Error ? err.message : String(err);
  }
}

function handleEvent(event: DaemonEvent): void {
  if (event.type === 'hello') {
    state.connected = true;
    return;
  }
  if (event.type === 'job.updated') {
    upsertJob(event.job);
    if (event.job.state === 'ready' && event.job.tabId && !filling.has(event.job.id)) {
      void runFill(event.job.id, event.job.tabId, false);
    }
    return;
  }
  if (event.type === 'job.log') {
    const job = state.jobs.find((j) => j.id === event.jobId);
    if (job) job.log = [...(job.log ?? []), event.entry];
    return;
  }
  if (event.type === 'outreach.updated') {
    upsertOutreach(event.target);
    return;
  }
  if (event.type === 'config.updated') state.config = event.config;
}

async function connect(): Promise<void> {
  const pairing = await loadPairing();
  if (!pairing.token) {
    state.connected = false;
    state.error = 'not paired: paste the daemon token in the extension Settings';
    return;
  }
  client = new DaemonClient(pairing.daemonUrl || DEFAULT_DAEMON, pairing.token);
  try {
    await client.health();
    await refreshLists();
  } catch (err) {
    state.connected = false;
    state.error = err instanceof Error ? err.message : String(err);
    scheduleReconnect();
    return;
  }
  ws?.close();
  ws = client.connectWs(handleEvent, () => {
    state.connected = false;
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, 4000);
}

async function filesFor(jobId: string): Promise<{ cv?: FilePayload; cover?: FilePayload }> {
  if (!client) return {};
  const out: { cv?: FilePayload; cover?: FilePayload } = {};
  for (const kind of ['cv', 'cover'] as const) {
    try {
      const f = await client.file(jobId, kind);
      if (f) out[kind] = { name: f.name, mime: f.mime, base64: bytesToBase64(f.bytes) };
    } catch {
      /* file optional */
    }
  }
  return out;
}

async function runFill(jobId: string, tabId: number, forceSubmit: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!client) return { ok: false, error: 'daemon not connected' };
  if (filling.has(jobId)) return { ok: false, error: 'already filling' };
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: 'unknown job' };
  if (job.posting.easyApplyOnly && !forceSubmit) {
    await client.markReview(jobId, 'LinkedIn Easy Apply is never auto-submitted');
    return { ok: true };
  }
  filling.add(jobId);
  try {
    for (let step = 0; step < 8; step++) {
      const schema = await sendMessage('scan', undefined, tabId);
      const mapped = await client.map(jobId, schema);
      const files = await filesFor(jobId);
      await sendMessage('fill', { answers: mapped.answers, files }, tabId);
      const auto = forceSubmit || mapped.gate.autoSubmit;
      if (!auto) {
        await client.markReview(jobId, mapped.gate.reasons.join('; ') || 'gate blocked auto-submit');
        return { ok: true };
      }
      const result = await sendMessage('submit', { force: forceSubmit }, tabId);
      if (result.nextClicked) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      if (result.submitted) {
        await client.submitted({
          jobId,
          submittedAt: new Date().toISOString(),
          url: result.url,
          confirmationText: result.confirmationText,
          mode: forceSubmit ? 'manual' : 'auto',
        });
        await refreshLists();
        return { ok: true };
      }
      await client.markReview(jobId, 'submit click did not produce a confirmation');
      return { ok: true };
    }
    await client.markReview(jobId, 'form still had steps after 8 pages');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    filling.delete(jobId);
  }
}

export default defineBackground(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });

  onMessage('getState', () => ({ ...state }));
  onMessage('getPairing', () => loadPairing());
  onMessage('pair', async ({ data }) => {
    await savePairing({ token: data.token.trim(), daemonUrl: data.daemonUrl?.trim() || DEFAULT_DAEMON });
    await connect();
    return { ok: state.connected, error: state.error };
  });
  onMessage('enqueue', async ({ data }) => {
    if (!client) throw new Error(state.error ?? 'daemon not connected');
    const result = await client.enqueue(data.posting, data.tabId);
    upsertJob(result.job);
    return result;
  });
  onMessage('retryJob', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    const result = await client.retry(data.jobId);
    upsertJob(result.job);
    return result;
  });
  onMessage('submitJob', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    const result = await client.submitted({
      jobId: data.jobId,
      submittedAt: new Date().toISOString(),
      url: data.url,
      confirmationText: data.confirmationText,
      mode: data.mode,
    });
    upsertJob(result.job);
    return result;
  });
  onMessage('markReview', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    const result = await client.markReview(data.jobId, data.reason);
    upsertJob(result.job);
    return result;
  });
  onMessage('sendOutreach', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    const result = await client.sendOutreach(data.id);
    upsertOutreach(result.target);
    return { ok: true };
  });
  onMessage('skipOutreach', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    const result = await client.skipOutreach(data.id);
    upsertOutreach(result.target);
    return { ok: true };
  });
  onMessage('startFill', async ({ data }) => runFill(data.jobId, data.tabId, Boolean(data.forceSubmit)));
  onMessage('doctor', async () => {
    if (!client) return { checks: [] };
    return client.doctor();
  });
  onMessage('patchConfig', async ({ data }) => {
    if (!client) throw new Error('daemon not connected');
    state.config = await client.patchConfig(data);
    return state.config;
  });
  onMessage('pageReady', async ({ data, sender }) => {
    const posting = data.posting;
    if (!posting || !client) return;
    const tabId = sender.tab?.id;
    const result = await client.enqueue(posting, tabId);
    upsertJob(result.job);
    if (result.job.state === 'ready' && tabId && !filling.has(result.job.id)) {
      void runFill(result.job.id, tabId, false);
    }
  });

  chrome.runtime.onInstalled.addListener(() => void connect());
  chrome.runtime.onStartup?.addListener(() => void connect());
  chrome.alarms.create('autopilot-reconnect', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'autopilot-reconnect' && !state.connected) void connect();
  });
  void connect();
});
