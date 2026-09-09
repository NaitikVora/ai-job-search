# Autopilot Chrome extension

Manifest V3 extension (WXT + React). It detects a job posting, sends the verbatim description to the local daemon, waits for a tailored CV and cover letter, fills the application form with per-ATS adapters, and (when the gate passes) submits. The side panel shows the pipeline, fit score, review reasons, tracker, and referral queue.

LinkedIn Easy Apply is detected and **never auto-submitted**. LinkedIn referral notes are copied to the clipboard; you open the profile and paste.

## Pair with the daemon

1. Start the daemon (`cd agent && npm start`) and copy the pairing token it prints. See [`agent/README.md`](../agent/README.md) for `/setup`, LaTeX, Apollo, and Gmail.
2. In this folder: `npm install && npm run build`.
3. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/.output/chrome-mv3`.
4. Open the extension **Settings** (or the side panel → Settings) and paste the token. Daemon URL defaults to `http://127.0.0.1:47831`.
5. Open a Greenhouse, Lever, Ashby, Workday, or other posting. The content script extracts the JD and enqueues it. When `/autoapply` finishes, the form is scanned, mapped, filled, and submitted if every gate passes.

Dev loop: `npm run dev` (WXT) reloads the unpacked extension.

## What it fills

Adapters (hostname + DOM):

| ATS | Hosts |
| --- | --- |
| Greenhouse | `boards.greenhouse.io`, `job-boards.greenhouse.io` |
| Lever | `jobs.lever.co` |
| Ashby | `jobs.ashbyhq.com` |
| Workday | `*.myworkdayjobs.com` |
| LinkedIn | `linkedin.com/jobs` (detect + Easy Apply flag only) |
| Generic | any page with JSON-LD `JobPosting` or a visible form |

JSON-LD is preferred; adapters and heuristics fill gaps. Multi-step forms loop scan → map → fill → next (up to 8 pages). CAPTCHA, low-confidence fields, missing required answers, Easy Apply, and a fit below `minFitToApply` send the job to **needs review**.

## Side panel

- **Pipeline** — every job the daemon knows about, with logs, Retry, Fill this tab, and “I submitted it”.
- **Outreach** — drafted emails, Send / Skip, “Open LinkedIn + copy note”.
- **Tracker** — `job_search_tracker.csv` as the daemon last read it.

## Scripts

```bash
npm install
npm test          # wxt prepare + vitest (jsdom)
npm run build     # production MV3 in .output/chrome-mv3
npm run dev       # watch
```

`.output/` and `.wxt/` are gitignored.
