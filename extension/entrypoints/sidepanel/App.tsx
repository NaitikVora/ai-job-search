import { useCallback, useEffect, useState } from 'react';
import type { ApplicationJob, OutreachTarget, PublicConfig, TrackerRow } from '@protocol';
import { emptyFeed, type FeedEntry, type FeedState } from '../../src/feed';
import { sendMessage } from '../../src/messaging';

type Tab = 'feed' | 'pipeline' | 'outreach' | 'tracker';

interface State {
  connected: boolean;
  config?: PublicConfig;
  jobs: ApplicationJob[];
  outreach: OutreachTarget[];
  tracker: TrackerRow[];
  feed: FeedState;
  error?: string;
}

export function App() {
  const [tab, setTab] = useState<Tab>('feed');
  const [state, setState] = useState<State>({
    connected: false,
    jobs: [],
    outreach: [],
    tracker: [],
    feed: emptyFeed(),
  });
  const [busy, setBusy] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await sendMessage('getState');
      setState(next);
    } catch (err) {
      setState((s) => ({ ...s, connected: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="app">
      <header>
        <h1>Autopilot</h1>
        <div className={`status ${state.connected ? 'ok' : 'bad'}`}>
          {state.connected ? `connected · ${state.config?.version ?? ''}` : state.error ?? 'daemon offline'}
          {' · '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Settings
          </a>
        </div>
      </header>
      <nav>
        {(['feed', 'pipeline', 'outreach', 'tracker'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'feed' && (
          <Feed
            feed={state.feed}
            autoSubmit={state.config?.autopilot.autoSubmit}
            connected={state.connected}
            busy={busy}
            setBusy={setBusy}
            onDone={refresh}
          />
        )}
        {tab === 'pipeline' && (
          <Pipeline
            jobs={state.jobs}
            feed={state.feed}
            busy={busy}
            setBusy={setBusy}
            onDone={refresh}
          />
        )}
        {tab === 'outreach' && <Outreach targets={state.outreach} busy={busy} setBusy={setBusy} onDone={refresh} />}
        {tab === 'tracker' && <Tracker rows={state.tracker} />}
      </main>
    </div>
  );
}

function Feed({
  feed,
  autoSubmit,
  connected,
  busy,
  setBusy,
  onDone,
}: {
  feed: FeedState;
  autoSubmit?: boolean;
  connected: boolean;
  busy?: string;
  setBusy: (s: string | undefined) => void;
  onDone: () => void;
}) {
  const [sourceUrl, setSourceUrl] = useState(feed.sourceUrl);
  const [count, setCount] = useState(10);
  const [message, setMessage] = useState('');

  useEffect(() => setSourceUrl(feed.sourceUrl), [feed.sourceUrl]);

  const counts = feed.entries.reduce<Record<string, number>>((all, entry) => {
    all[entry.status] = (all[entry.status] ?? 0) + 1;
    return all;
  }, {});
  const active = feed.entries.find((entry) => entry.id === feed.activeId);
  const prepared = feed.entries.filter((entry) => entry.status !== 'unseen');
  const visible = [...prepared, ...feed.entries.filter((entry) => entry.status === 'unseen')]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
    .slice(0, 30);

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setMessage('');
    try {
      await fn();
      await onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <article className="card">
        <h2>Latest-first review queue</h2>
        <p className="meta">
          Syncs the SpeedyApply markdown feed, tailors one application at a time, fills every
          reachable step, and stops before final submit. Each prepared application stays open in
          its own tab.
        </p>
        <label className="meta" htmlFor="feed-url">GitHub markdown feed</label>
        <input
          id="feed-url"
          className="field"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
        />
        <div className="row">
          <button
            className="act ghost"
            disabled={busy === 'feed-sync'}
            onClick={() =>
              void run('feed-sync', async () => {
                await sendMessage('syncFeed', { sourceUrl });
                setMessage('Feed synced.');
              })
            }
          >
            Sync latest
          </button>
          <label className="batch-count">
            <span>Jobs</span>
            <input
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(event) => setCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
            />
          </label>
          <button
            className="act"
            disabled={!connected || feed.running || busy === 'feed-start'}
            onClick={() =>
              void run('feed-start', async () => {
                await sendMessage('startReviewBatch', { count });
                setMessage('Review batch started. Auto-submit is off.');
              })
            }
          >
            Prepare next
          </button>
          {feed.running && (
            <button
              className="act ghost"
              disabled={busy === 'feed-stop'}
              onClick={() =>
                void run('feed-stop', async () => {
                  await sendMessage('stopReviewBatch');
                  setMessage('Pending jobs stopped; the active job will finish.');
                })
              }
            >
              Stop after active
            </button>
          )}
        </div>
        <p className="meta">
          {feed.syncedAt
            ? `${feed.entries.length} jobs · synced ${new Date(feed.syncedAt).toLocaleString()}`
            : 'Not synced yet'}
          {` · ${counts.unseen ?? 0} unseen · ${counts.review ?? 0} ready for review`}
          {feed.running ? ` · ${feed.queue.length} queued` : ''}
        </p>
        {active && <p className="meta">Preparing now: {active.company} · {active.title}</p>}
        <p className={`status ${autoSubmit === false ? 'ok' : 'bad'}`}>
          {autoSubmit === false
            ? 'Review mode enforced: final submit is disabled.'
            : 'Auto-submit is currently enabled. Starting this queue will turn it off.'}
        </p>
        {(feed.lastError || message) && (
          <p className={`status ${feed.lastError ? 'bad' : 'ok'}`}>{feed.lastError ?? message}</p>
        )}
      </article>

      {visible.length === 0 ? (
        <div className="empty">Sync the feed to load the latest jobs.</div>
      ) : (
        visible.map((entry) => (
          <FeedCard
            key={entry.id}
            entry={entry}
            busy={busy}
            run={run}
          />
        ))
      )}
      {feed.entries.length > visible.length && (
        <div className="meta">Showing 30 of {feed.entries.length} feed entries.</div>
      )}
    </>
  );
}

function FeedCard({
  entry,
  busy,
  run,
}: {
  entry: FeedEntry;
  busy?: string;
  run: (id: string, fn: () => Promise<void>) => Promise<void>;
}) {
  return (
    <article className="card">
      <h2>{entry.title}</h2>
      <div className="meta">
        <span className={`badge ${entry.status}`}>{entry.status.replace('_', ' ')}</span>
        {entry.company} · {entry.location} · {entry.ageLabel} old · {entry.section}
      </div>
      {entry.error && <div className="meta">error: {entry.error}</div>}
      <div className="row">
        {(entry.tabId || entry.status === 'review') && (
          <button
            className="act ghost"
            disabled={busy === `open-${entry.id}`}
            onClick={() =>
              void run(`open-${entry.id}`, async () => {
                const result = await sendMessage('openFeedTab', { entryId: entry.id });
                if (!result.ok) throw new Error(result.error);
              })
            }
          >
            Open review tab
          </button>
        )}
        {(entry.status === 'failed' || entry.status === 'skipped') && (
          <button
            className="act ghost"
            disabled={busy === `reset-${entry.id}`}
            onClick={() =>
              void run(`reset-${entry.id}`, async () => {
                await sendMessage('resetFeedEntry', { entryId: entry.id });
              })
            }
          >
            Reset for retry
          </button>
        )}
      </div>
    </article>
  );
}

function Pipeline({
  jobs,
  feed,
  busy,
  setBusy,
  onDone,
}: {
  jobs: ApplicationJob[];
  feed: FeedState;
  busy?: string;
  setBusy: (s: string | undefined) => void;
  onDone: () => void;
}) {
  if (!jobs.length) return <div className="empty">Open a job posting. The extension will detect it and queue a tailored application.</div>;
  return (
    <>
      {jobs.map((job) => (
        <article className="card" key={job.id}>
          <h2>{job.posting.title}</h2>
          <div className="meta">
            <span className={`badge ${job.state}`}>{job.state.replace('_', ' ')}</span>
            {job.posting.company} · {job.posting.ats}
            {job.fit ? ` · fit ${job.fit.overall}` : ''}
          </div>
          {job.gate && !job.gate.autoSubmit && job.gate.reasons.length > 0 && (
            <div className="meta">review: {job.gate.reasons.join('; ')}</div>
          )}
          {job.error && <div className="meta">error: {job.error}</div>}
          <div className="log">{job.log.slice(-6).map((l) => l.message).join('\n')}</div>
          <div className="row">
            {job.state === 'failed' || job.state === 'skipped' ? (
              <button
                className="act"
                disabled={busy === job.id}
                onClick={() => void act(`retry-${job.id}`, setBusy, async () => { await sendMessage('retryJob', { jobId: job.id }); await onDone(); })}
              >
                Retry
              </button>
            ) : null}
            {job.state === 'ready' || job.state === 'needs_review' ? (
              <>
                <button
                  className="act"
                  disabled={busy === job.id}
                  onClick={() =>
                    void act(job.id, setBusy, async () => {
                      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                      if (!tab?.id) throw new Error('no active tab');
                      const fromReviewFeed = feed.entries.some((entry) => entry.jobId === job.id);
                      await sendMessage('startFill', {
                        jobId: job.id,
                        tabId: tab.id,
                        forceSubmit: job.state === 'needs_review' && !fromReviewFeed,
                        reviewOnly: fromReviewFeed,
                      });
                      await onDone();
                    })
                  }
                >
                  {feed.entries.some((entry) => entry.jobId === job.id)
                    ? 'Refill this tab'
                    : job.state === 'needs_review'
                      ? 'Fill + submit'
                      : 'Fill this tab'}
                </button>
                {job.state === 'needs_review' && (
                  <button
                    className="act ghost"
                    onClick={() =>
                      void act(job.id, setBusy, async () => {
                        await sendMessage('submitJob', { jobId: job.id, url: job.posting.applyUrl ?? job.posting.url, mode: 'manual' });
                        await onDone();
                      })
                    }
                  >
                    I submitted it
                  </button>
                )}
              </>
            ) : null}
          </div>
        </article>
      ))}
    </>
  );
}

function Outreach({
  targets,
  busy,
  setBusy,
  onDone,
}: {
  targets: OutreachTarget[];
  busy?: string;
  setBusy: (s: string | undefined) => void;
  onDone: () => void;
}) {
  if (!targets.length) return <div className="empty">Referral drafts appear here after an application is submitted.</div>;
  return (
    <>
      {targets.map((t) => (
        <article className="card" key={t.id}>
          <h2>{t.name}</h2>
          <div className="meta">
            <span className={`badge ${t.status}`}>{t.status}</span>
            {t.title} · {t.company}
          </div>
          <div className="meta">{t.relevance}{t.email ? ` · ${t.email}` : ' · no email'}</div>
          {t.emailSubject && <div className="meta">{t.emailSubject}</div>}
          {t.emailBody && <div className="note">{t.emailBody}</div>}
          {t.linkedinNote && (
            <div className="note">
              LinkedIn (paste by hand): {t.linkedinNote}
            </div>
          )}
          <div className="row">
            {t.status === 'drafted' && t.email && (
              <button
                className="act"
                disabled={busy === t.id}
                onClick={() => void act(t.id, setBusy, async () => { await sendMessage('sendOutreach', { id: t.id }); await onDone(); })}
              >
                Send email
              </button>
            )}
            {t.status === 'drafted' && (
              <button
                className="act ghost"
                onClick={() => void act(t.id, setBusy, async () => { await sendMessage('skipOutreach', { id: t.id }); await onDone(); })}
              >
                Skip
              </button>
            )}
            {t.linkedinUrl && (
              <button
                className="act ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(t.linkedinNote ?? '');
                  void chrome.tabs.create({ url: t.linkedinUrl });
                }}
              >
                Open LinkedIn + copy note
              </button>
            )}
          </div>
        </article>
      ))}
    </>
  );
}

function Tracker({ rows }: { rows: TrackerRow[] }) {
  if (!rows.length) return <div className="empty">No tracker rows yet.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Company</th>
          <th>Role</th>
          <th>Status</th>
          <th>Fit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.company}-${r.role}-${i}`}>
            <td>{r.date}</td>
            <td>{r.company}</td>
            <td>{r.role}</td>
            <td>{r.status}</td>
            <td>{r.fit_rating}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function act(id: string, setBusy: (s: string | undefined) => void, fn: () => Promise<void>): Promise<void> {
  setBusy(id);
  try {
    await fn();
  } finally {
    setBusy(undefined);
  }
}
