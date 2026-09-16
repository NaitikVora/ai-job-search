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

## SpeedyApply latest-first review queue

The **Feed** tab is preconfigured for
[`speedyapply/2027-SWE-College-Jobs/NEW_GRAD_USA.md`](https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md).

1. Click **Sync latest**. The extension fetches the raw markdown, parses all three tables,
   deduplicates application URLs, and orders them by the numeric `Age` column (smallest age
   first). The source provides relative age, not a permanent posting date.
2. Choose a batch size (default 10, maximum 50) and click **Prepare next**.
3. The queue turns daemon `autopilot.autoSubmit` off, opens one job, evaluates fit, creates and
   verifies the tailored CV and cover letter, fills every reachable form step, and stops at the
   final submit action. Only then does it open the next job. Finished jobs remain in separate
   Chrome tabs.
4. Review the employer form and generated documents in each tab. Submit by hand. A visible
   confirmation is recorded automatically; use **Pipeline → I submitted it** if an ATS does not
   expose a detectable confirmation.
5. Titles and companies that match the visa / clearance / school-lock / staffing-mill skip list
   (Starshield, Booz Allen, ActioNet, "UF Only", "Georgia Tech Only", W2 mills, PhD-only) are
   marked skipped and never opened.

Progress and deduplication persist in `chrome.storage.local`, including across service-worker and
browser restarts. **Stop after active** returns unopened jobs to the unseen queue. The extension
refreshes the feed hourly after the first sync, but never starts a review batch or opens tabs
without your click.

The batch limit is deliberate: preparing hundreds of applications at once would open hundreds of
tabs, spend model budget, and exceed the daemon's daily application cap. Repeated **Prepare next**
batches continue through the feed in latest-first order.

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

- **Feed** — SpeedyApply sync, latest-first batch controls, persistent status, and review-tab links.
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
