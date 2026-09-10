import type {
  ApplicationJob,
  DaemonEvent,
  DoctorCheck,
  FormSchema,
  JobPosting,
  MapFieldsResponse,
  OutreachTarget,
  PublicConfig,
  SubmissionReport,
  TrackerRow,
} from '@protocol';

export class DaemonError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export class DaemonClient {
  constructor(
    public baseUrl: string,
    public token: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers({ 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }),
    });
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    if (!res.ok) {
      const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new DaemonError(msg, res.status);
    }
    return body as T;
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return fetch(`${this.baseUrl}/api/health`).then(async (r) => {
      if (!r.ok) throw new DaemonError(`daemon health ${r.status}`, r.status);
      return r.json();
    });
  }

  doctor(): Promise<{ checks: DoctorCheck[] }> {
    return this.json('/api/doctor');
  }

  config(): Promise<PublicConfig> {
    return this.json('/api/config');
  }

  patchConfig(patch: unknown): Promise<PublicConfig> {
    return this.json('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
  }

  listJobs(): Promise<{ jobs: ApplicationJob[] }> {
    return this.json('/api/jobs');
  }

  enqueue(posting: JobPosting, tabId?: number): Promise<{ job: ApplicationJob; created: boolean }> {
    return this.json('/api/jobs', { method: 'POST', body: JSON.stringify({ posting, tabId }) });
  }

  retry(jobId: string): Promise<{ job: ApplicationJob }> {
    return this.json(`/api/jobs/${jobId}/retry`, { method: 'POST', body: '{}' });
  }

  map(jobId: string, form: FormSchema): Promise<MapFieldsResponse> {
    return this.json(`/api/jobs/${jobId}/map`, { method: 'POST', body: JSON.stringify({ form }) });
  }

  markReview(jobId: string, reason: string): Promise<{ job: ApplicationJob }> {
    return this.json(`/api/jobs/${jobId}/review`, { method: 'POST', body: JSON.stringify({ reason }) });
  }

  submitted(report: SubmissionReport): Promise<{ job: ApplicationJob }> {
    return this.json(`/api/jobs/${report.jobId}/submitted`, { method: 'POST', body: JSON.stringify(report) });
  }

  async file(jobId: string, kind: 'cv' | 'cover'): Promise<{ name: string; mime: string; bytes: Uint8Array } | undefined> {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}/files/${kind}`, { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new DaemonError(`file ${kind} HTTP ${res.status}`, res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    const disp = res.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disp);
    return { name: match?.[1] ?? `${kind}.pdf`, mime: res.headers.get('content-type') ?? 'application/pdf', bytes: buf };
  }

  tracker(): Promise<{ rows: TrackerRow[] }> {
    return this.json('/api/tracker');
  }

  outreach(): Promise<{ targets: OutreachTarget[] }> {
    return this.json('/api/outreach');
  }

  sendOutreach(id: string): Promise<{ target: OutreachTarget }> {
    return this.json(`/api/outreach/${id}/send`, { method: 'POST', body: '{}' });
  }

  skipOutreach(id: string): Promise<{ target: OutreachTarget }> {
    return this.json(`/api/outreach/${id}/skip`, { method: 'POST', body: '{}' });
  }

  connectWs(onEvent: (e: DaemonEvent) => void, onClose: () => void): WebSocket {
    const url = this.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.addEventListener('message', (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)) as DaemonEvent);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
    return ws;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
