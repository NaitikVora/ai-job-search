import { useCallback, useEffect, useState } from 'react';
import type { ApplicationJob, OutreachTarget, PublicConfig, TrackerRow } from '@protocol';
import { sendMessage } from '../../src/messaging';

type Tab = 'pipeline' | 'outreach' | 'tracker';

interface State {
  connected: boolean;
  config?: PublicConfig;
  jobs: ApplicationJob[];
  outreach: OutreachTarget[];
  tracker: TrackerRow[];
  error?: string;
}

export function App() {
  const [tab, setTab] = useState<Tab>('pipeline');
  const [state, setState] = useState<State>({ connected: false, jobs: [], outreach: [], tracker: [] });
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
        {(['pipeline', 'outreach', 'tracker'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'pipeline' && <Pipeline jobs={state.jobs} busy={busy} setBusy={setBusy} onDone={refresh} />}
        {tab === 'outreach' && <Outreach targets={state.outreach} busy={busy} setBusy={setBusy} onDone={refresh} />}
        {tab === 'tracker' && <Tracker rows={state.tracker} />}
      </main>
    </div>
  );
}

function Pipeline({
  jobs,
  busy,
  setBusy,
  onDone,
}: {
  jobs: ApplicationJob[];
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
                      await sendMessage('startFill', { jobId: job.id, tabId: tab.id, forceSubmit: job.state === 'needs_review' });
                      await onDone();
                    })
                  }
                >
                  {job.state === 'needs_review' ? 'Fill + submit' : 'Fill this tab'}
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
