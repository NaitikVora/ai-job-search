import { useEffect, useState } from 'react';
import { sendMessage } from '../../src/messaging';

export function OptionsApp() {
  const [token, setToken] = useState('');
  const [daemonUrl, setDaemonUrl] = useState('http://127.0.0.1:47831');
  const [status, setStatus] = useState('');
  const [checks, setChecks] = useState<Array<{ name: string; ok: boolean; detail: string; required: boolean }>>([]);

  useEffect(() => {
    void sendMessage('getPairing').then((p) => {
      setToken(p.token);
      setDaemonUrl(p.daemonUrl);
    });
  }, []);

  async function save() {
    setStatus('pairing…');
    const result = await sendMessage('pair', { token, daemonUrl });
    setStatus(result.ok ? 'connected' : result.error ?? 'failed');
    if (result.ok) {
      const d = await sendMessage('doctor');
      setChecks(d.checks);
    }
  }

  return (
    <div className="app" style={{ maxWidth: 640, margin: '0 auto' }}>
      <header>
        <h1>Autopilot settings</h1>
        <div className="status">Pair this browser with the local daemon (`cd agent && npm start`).</div>
      </header>
      <main>
        <div className="card">
          <label className="meta" htmlFor="url">Daemon URL</label>
          <input id="url" value={daemonUrl} onChange={(e) => setDaemonUrl(e.target.value)} style={{ width: '100%', margin: '4px 0 10px', padding: 8 }} />
          <label className="meta" htmlFor="token">Pairing token</label>
          <input id="token" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: '100%', margin: '4px 0 10px', padding: 8 }} placeholder="printed at daemon startup" />
          <div className="row">
            <button className="act" onClick={() => void save()}>Save and connect</button>
          </div>
          {status && <p className="meta">{status}</p>}
        </div>
        {checks.length > 0 && (
          <div className="card">
            <h2>Doctor</h2>
            {checks.map((c) => (
              <p key={c.name} className="meta">
                <span className={`badge ${c.ok ? 'submitted' : c.required ? 'failed' : 'needs_review'}`}>
                  {c.ok ? 'ok' : c.required ? 'fail' : 'warn'}
                </span>
                {c.name}: {c.detail}
              </p>
            ))}
          </div>
        )}
        <div className="card">
          <h2>LinkedIn</h2>
          <p className="meta">
            Referral emails can be sent from Gmail. LinkedIn notes are drafted only — open the profile and paste the note yourself. Automated LinkedIn messaging is never used.
          </p>
        </div>
      </main>
    </div>
  );
}
