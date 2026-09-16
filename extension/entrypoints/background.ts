import type { ApplicationJob, DaemonEvent, JobPosting, OutreachTarget, PublicConfig, TrackerRow } from '@protocol';
import { bytesToBase64, DaemonClient } from '../src/client';
import {
  canonicalJobUrl,
  DEFAULT_SPEEDYAPPLY_FEED,
  emptyFeed,
  enqueueNextUnseen,
  githubRawUrl,
  mergeFeedEntries,
  parseSpeedyApplyMarkdown,
  stopPendingFeed,
  type FeedEntry,
  type FeedEntryStatus,
  type FeedState,
} from '../src/feed';
import { onMessage, sendMessage, type FilePayload } from '../src/messaging';
import { DEFAULT_DAEMON, loadPairing, savePairing } from '../src/storage';

interface State {
  connected: boolean;
  config?: PublicConfig;
  jobs: ApplicationJob[];
  outreach: OutreachTarget[];
  tracker: TrackerRow[];
  feed: FeedState;
  error?: string;
}

const FEED_STORAGE_KEY = 'speedyapplyFeed';
const TERMINAL_FEED_STATUSES = new Set<FeedEntryStatus>([
  'review',
  'submitted',
  'skipped',
  'failed',
]);

const state: State = {
  connected: false,
  jobs: [],
  outreach: [],
  tracker: [],
  feed: emptyFeed(),
};
const filling = new Set<string>();
let client: DaemonClient | undefined;
let ws: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pumpBusy = false;

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

function feedStatusForJob(job: ApplicationJob): FeedEntryStatus {
  if (job.state === 'queued' || job.state === 'tailoring') return 'tailoring';
  if (job.state === 'ready' || job.state === 'filling') return 'filling';
  if (job.state === 'needs_review') return 'review';
  if (job.state === 'submitted') return 'submitted';
  if (job.state === 'skipped') return 'skipped';
  return 'failed';
}

function feedEntryForJob(job: ApplicationJob): FeedEntry | undefined {
  return (
    state.feed.entries.find((entry) => entry.jobId === job.id) ??
    state.feed.entries.find(
      (entry) =>
        (job.tabId !== undefined && entry.tabId === job.tabId) ||
        canonicalJobUrl(entry.url) === canonicalJobUrl(job.posting.url) ||
        (job.posting.applyUrl &&
          canonicalJobUrl(entry.url) === canonicalJobUrl(job.posting.applyUrl)),
    )
  );
}

function feedEntryForTab(tabId: number | undefined): FeedEntry | undefined {
  return tabId === undefined
    ? undefined
    : state.feed.entries.find((entry) => entry.tabId === tabId);
}

async function persistFeed(): Promise<void> {
  await chrome.storage.local.set({ [FEED_STORAGE_KEY]: state.feed });
}

async function restoreFeed(): Promise<void> {
  const stored = await chrome.storage.local.get(FEED_STORAGE_KEY);
  const candidate = stored[FEED_STORAGE_KEY] as Partial<FeedState> | undefined;
  if (!candidate || !Array.isArray(candidate.entries)) return;
  state.feed = {
    sourceUrl:
      typeof candidate.sourceUrl === 'string'
        ? candidate.sourceUrl
        : DEFAULT_SPEEDYAPPLY_FEED,
    rawUrl:
      typeof candidate.rawUrl === 'string'
        ? candidate.rawUrl
        : githubRawUrl(DEFAULT_SPEEDYAPPLY_FEED),
    syncedAt:
      typeof candidate.syncedAt === 'string' ? candidate.syncedAt : undefined,
    entries: candidate.entries,
    queue: Array.isArray(candidate.queue)
      ? candidate.queue.filter((id): id is string => typeof id === 'string')
      : [],
    activeId:
      typeof candidate.activeId === 'string' ? candidate.activeId : undefined,
    running: Boolean(candidate.running),
    lastError:
      typeof candidate.lastError === 'string' ? candidate.lastError : undefined,
  };

  // A service-worker restart can happen while Chrome remains open. If the active tab vanished,
  // put the entry back into the queue instead of leaving the batch stuck forever.
  if (state.feed.activeId) {
    const active = state.feed.entries.find((entry) => entry.id === state.feed.activeId);
    if (active && TERMINAL_FEED_STATUSES.has(active.status)) {
      state.feed.activeId = undefined;
      state.feed.running = state.feed.queue.length > 0;
      await persistFeed();
      return;
    }
    const tabExists = active?.tabId
      ? await chrome.tabs.get(active.tabId).then(
          () => true,
          () => false,
        )
      : false;
    if (!tabExists && active && !TERMINAL_FEED_STATUSES.has(active.status)) {
      active.status = 'queued';
      active.tabId = undefined;
      state.feed.queue.unshift(active.id);
      state.feed.activeId = undefined;
    }
  }
}

async function syncReviewFeed(sourceUrl = state.feed.sourceUrl): Promise<FeedState> {
  const rawUrl = githubRawUrl(sourceUrl);
  const res = await fetch(rawUrl, {
    headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > 2_000_000) throw new Error('feed is larger than the 2 MB safety limit');
  const markdown = await res.text();
  if (markdown.length > 2_000_000) throw new Error('feed is larger than the 2 MB safety limit');
  const parsed = parseSpeedyApplyMarkdown(markdown);
  if (parsed.length === 0) throw new Error('no SpeedyApply job rows found in the feed');

  const entries = mergeFeedEntries(parsed, state.feed.entries);
  for (const entry of entries) {
    const known = state.jobs.find(
      (job) =>
        canonicalJobUrl(job.posting.url) === canonicalJobUrl(entry.url) ||
        (job.posting.applyUrl &&
          canonicalJobUrl(job.posting.applyUrl) === canonicalJobUrl(entry.url)),
    );
    if (known) {
      entry.jobId = known.id;
      entry.tabId = entry.tabId ?? known.tabId;
      entry.status = feedStatusForJob(known);
      entry.error = known.error;
    }
  }

  state.feed = {
    ...state.feed,
    sourceUrl,
    rawUrl,
    syncedAt: new Date().toISOString(),
    entries,
    queue: state.feed.queue.filter((id) => entries.some((entry) => entry.id === id)),
    lastError: undefined,
  };
  await persistFeed();
  return state.feed;
}

async function startReviewBatch(count: number): Promise<FeedState> {
  if (!client) throw new Error(state.error ?? 'daemon not connected');
  if (state.feed.entries.length === 0) await syncReviewFeed();

  // This queue is explicitly fill-for-review. Do not rely on a stale local config or on a model
  // confidence gate to prevent submission; turn autoSubmit off at the daemon itself.
  state.config = await client.patchConfig({ autopilot: { autoSubmit: false } });

  state.feed = enqueueNextUnseen(state.feed, count);
  await persistFeed();
  void pumpFeed();
  return state.feed;
}

async function stopReviewBatch(): Promise<FeedState> {
  state.feed = stopPendingFeed(state.feed);
  await persistFeed();
  return state.feed;
}

async function resetFeedEntry(entryId: string): Promise<FeedState> {
  const entry = state.feed.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error('unknown feed entry');
  if (state.feed.activeId === entryId) throw new Error('cannot reset the active entry; stop after it reaches review');
  state.feed.queue = state.feed.queue.filter((id) => id !== entryId);
  entry.status = 'unseen';
  entry.tabId = undefined;
  entry.jobId = undefined;
  entry.error = undefined;
  await persistFeed();
  return state.feed;
}

async function openExistingFeedTab(entryId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = state.feed.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return { ok: false, error: 'unknown feed entry' };
  if (entry.tabId) {
    const found = await chrome.tabs.get(entry.tabId).then(
      (tab) => tab,
      () => undefined,
    );
    if (found) {
      await chrome.tabs.update(entry.tabId, { active: true });
      if (found.windowId) await chrome.windows.update(found.windowId, { focused: true });
      return { ok: true };
    }
  }
  const job = entry.jobId
    ? state.jobs.find((candidate) => candidate.id === entry.jobId)
    : undefined;
  const tab = await chrome.tabs.create({
    url: job?.posting.applyUrl ?? entry.url,
    active: true,
  });
  entry.tabId = tab.id;
  await persistFeed();
  return { ok: true };
}

async function pumpFeed(): Promise<void> {
  if (pumpBusy || state.feed.activeId || !state.feed.running) return;
  const id = state.feed.queue.shift();
  if (!id) {
    state.feed.running = false;
    await persistFeed();
    return;
  }
  const entry = state.feed.entries.find((candidate) => candidate.id === id);
  if (!entry || TERMINAL_FEED_STATUSES.has(entry.status)) {
    await persistFeed();
    void pumpFeed();
    return;
  }

  pumpBusy = true;
  try {
    entry.status = 'opening';
    state.feed.activeId = entry.id;
    await persistFeed();
    const tab = await chrome.tabs.create({ url: entry.url, active: false });
    if (!tab.id) throw new Error('Chrome did not return a tab id');
    entry.tabId = tab.id;
    entry.status = 'loading';
    await persistFeed();
  } catch (err) {
    entry.status = 'failed';
    entry.error = err instanceof Error ? err.message : String(err);
    state.feed.activeId = undefined;
    await persistFeed();
    void pumpFeed();
  } finally {
    pumpBusy = false;
  }
}

async function finishFeedEntry(entry: FeedEntry, status: FeedEntryStatus, error?: string): Promise<void> {
  entry.status = status;
  entry.error = error;
  if (state.feed.activeId === entry.id) state.feed.activeId = undefined;
  await persistFeed();
  if (state.feed.running) void pumpFeed();
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
    for (const entry of state.feed.entries) {
      const job = entry.jobId
        ? state.jobs.find((candidate) => candidate.id === entry.jobId)
        : undefined;
      if (!job) continue;
      entry.status = feedStatusForJob(job);
      entry.error = job.error;
      if (job.state === 'ready' && entry.tabId && !filling.has(job.id)) {
        void prepareFeedJob(job, entry);
      } else if (
        state.feed.activeId === entry.id &&
        (job.state === 'needs_review' ||
          job.state === 'submitted' ||
          job.state === 'skipped' ||
          job.state === 'failed')
      ) {
        void finishFeedEntry(entry, feedStatusForJob(job), job.error);
      }
    }
    await persistFeed();
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
    const feedEntry = feedEntryForJob(event.job);
    if (feedEntry) {
      feedEntry.jobId = event.job.id;
      feedEntry.tabId = feedEntry.tabId ?? event.job.tabId;
      feedEntry.status = feedStatusForJob(event.job);
      feedEntry.error = event.job.error;
      void persistFeed();
      if (event.job.state === 'ready' && feedEntry.tabId && !filling.has(event.job.id)) {
        void prepareFeedJob(event.job, feedEntry);
      } else if (
        event.job.state === 'needs_review' ||
        event.job.state === 'submitted' ||
        event.job.state === 'skipped' ||
        event.job.state === 'failed'
      ) {
        void finishFeedEntry(feedEntry, feedStatusForJob(event.job), event.job.error);
      }
    } else if (
      event.job.state === 'ready' &&
      event.job.tabId &&
      !filling.has(event.job.id)
    ) {
      void runFill(event.job.id, event.job.tabId, {
        forceSubmit: false,
        reviewOnly: false,
      });
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

async function prepareFeedJob(job: ApplicationJob, entry: FeedEntry): Promise<void> {
  const tabId = entry.tabId ?? job.tabId;
  if (!tabId) {
    await finishFeedEntry(entry, 'failed', 'no Chrome tab is associated with this job');
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    await finishFeedEntry(entry, 'failed', 'the review tab was closed before documents were ready');
    return;
  }
  const target = job.posting.applyUrl;
  if (
    target &&
    tab.url &&
    canonicalJobUrl(target) !== canonicalJobUrl(tab.url)
  ) {
    entry.status = 'loading';
    await persistFeed();
    await chrome.tabs.update(tabId, { url: target });
    return;
  }
  entry.status = 'filling';
  await persistFeed();
  const outcome = await runFill(job.id, tabId, {
    forceSubmit: false,
    reviewOnly: true,
  });
  if (!outcome.ok) await finishFeedEntry(entry, 'failed', outcome.error);
}

async function runFill(
  jobId: string,
  tabId: number,
  options: { forceSubmit: boolean; reviewOnly: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!client) return { ok: false, error: 'daemon not connected' };
  if (filling.has(jobId)) return { ok: false, error: 'already filling' };
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: 'unknown job' };
  if (job.posting.easyApplyOnly && !options.forceSubmit) {
    await client.markReview(jobId, 'LinkedIn Easy Apply is never auto-submitted');
    return { ok: true };
  }
  filling.add(jobId);
  try {
    for (let step = 0; step < 8; step++) {
      const schema = await sendMessage('scan', undefined, tabId);
      const mapped = await client.map(jobId, schema);
      const files = await filesFor(jobId);
      const filled = await sendMessage('fill', { answers: mapped.answers, files }, tabId);

      if (options.reviewOnly) {
        if (mapped.gate.unresolvedRequired > 0 || filled.errors.length > 0) {
          const reasons = [
            mapped.gate.unresolvedRequired > 0
              ? `${mapped.gate.unresolvedRequired} required field(s) need review`
              : '',
            filled.errors.length > 0 ? `${filled.errors.length} field(s) could not be filled` : '',
          ].filter(Boolean);
          await client.markReview(jobId, `batch review mode: ${reasons.join('; ')}`);
          return { ok: true };
        }
        const result = await sendMessage(
          'submit',
          { force: false, allowFinal: false },
          tabId,
        );
        if (result.nextClicked) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        await client.markReview(
          jobId,
          'batch review mode: every reachable field is filled; final submit was not clicked',
        );
        return { ok: true };
      }

      const auto = options.forceSubmit || mapped.gate.autoSubmit;
      if (!auto) {
        await client.markReview(jobId, mapped.gate.reasons.join('; ') || 'gate blocked auto-submit');
        return { ok: true };
      }
      const result = await sendMessage(
        'submit',
        { force: options.forceSubmit, allowFinal: true },
        tabId,
      );
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
          mode: options.forceSubmit ? 'manual' : 'auto',
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
  onMessage('startFill', async ({ data }) =>
    runFill(data.jobId, data.tabId, {
      forceSubmit: Boolean(data.forceSubmit),
      reviewOnly: Boolean(data.reviewOnly),
    }),
  );
  onMessage('syncFeed', async ({ data }) => {
    try {
      return await syncReviewFeed(data.sourceUrl?.trim() || state.feed.sourceUrl);
    } catch (err) {
      state.feed.lastError = err instanceof Error ? err.message : String(err);
      await persistFeed();
      return state.feed;
    }
  });
  onMessage('startReviewBatch', async ({ data }) => startReviewBatch(data.count));
  onMessage('stopReviewBatch', async () => stopReviewBatch());
  onMessage('openFeedTab', async ({ data }) => openExistingFeedTab(data.entryId));
  onMessage('resetFeedEntry', async ({ data }) => resetFeedEntry(data.entryId));
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
    const tabId = sender.tab?.id;
    const feedEntry = feedEntryForTab(tabId);
    if (!client) return;

    if (feedEntry?.jobId) {
      const existing = state.jobs.find((job) => job.id === feedEntry.jobId);
      if (
        (existing?.state === 'ready' || existing?.state === 'needs_review') &&
        tabId &&
        !filling.has(existing.id)
      ) {
        void prepareFeedJob(existing, feedEntry);
      }
      // The application form often cannot be extracted as a posting. Its association with
      // the original job is the feed tab id, so no second posting is needed here.
      return;
    }

    const posting = data.posting;
    if (!posting) return;
    const mergedPosting: JobPosting = feedEntry
      ? {
          ...posting,
          company: posting.company || feedEntry.company,
          title: posting.title || feedEntry.title,
          location: posting.location || feedEntry.location,
          companyDomain:
            posting.companyDomain ||
            (() => {
              try {
                return feedEntry.companyUrl
                  ? new URL(feedEntry.companyUrl).hostname.replace(/^www\./, '')
                  : undefined;
              } catch {
                return undefined;
              }
            })(),
        }
      : posting;
    const result = await client.enqueue(mergedPosting, tabId);
    upsertJob(result.job);
    if (feedEntry) {
      feedEntry.jobId = result.job.id;
      feedEntry.status = feedStatusForJob(result.job);
      feedEntry.error = result.job.error;
      await persistFeed();
    }
    if (result.job.state === 'ready' && tabId && !filling.has(result.job.id)) {
      if (feedEntry) void prepareFeedJob(result.job, feedEntry);
      else {
        void runFill(result.job.id, tabId, {
          forceSubmit: false,
          reviewOnly: false,
        });
      }
    }
  });
  onMessage('manualSubmissionDetected', async ({ data, sender }) => {
    if (!client || sender.tab?.id === undefined) return;
    const job = state.jobs.find(
      (candidate) =>
        candidate.tabId === sender.tab?.id &&
        candidate.state !== 'submitted' &&
        candidate.state !== 'skipped' &&
        candidate.state !== 'failed',
    );
    if (!job) return;
    const result = await client.submitted({
      jobId: job.id,
      submittedAt: new Date().toISOString(),
      url: data.url,
      confirmationText: data.confirmationText,
      mode: 'manual',
    });
    upsertJob(result.job);
    const entry = feedEntryForJob(result.job);
    if (entry) await finishFeedEntry(entry, 'submitted');
  });

  chrome.runtime.onInstalled.addListener(() => void connect());
  chrome.runtime.onStartup?.addListener(() => void connect());
  chrome.alarms.create('autopilot-reconnect', { periodInMinutes: 1 });
  chrome.alarms.create('speedyapply-feed-sync', { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'autopilot-reconnect' && !state.connected) void connect();
    if (a.name === 'speedyapply-feed-sync' && state.feed.syncedAt) {
      void syncReviewFeed().catch(async (err) => {
        state.feed.lastError = err instanceof Error ? err.message : String(err);
        await persistFeed();
      });
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const entry = feedEntryForTab(tabId);
    if (!entry || TERMINAL_FEED_STATUSES.has(entry.status)) return;
    void finishFeedEntry(entry, 'failed', 'review tab was closed before preparation finished');
  });
  void restoreFeed().then(async () => {
    await connect();
    if (state.feed.running) void pumpFeed();
  });
});
