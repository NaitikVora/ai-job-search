# Autopilot daemon

Local Node service that the Chrome extension talks to. It runs `/autoapply` through the Claude Agent SDK, maps form fields to grounded answers, gates auto-submit, updates `job_search_tracker.csv`, and sends referral emails via Apollo + Gmail.

LinkedIn messages are **never sent automatically**. The daemon only drafts a note; you paste it by hand.

## Prerequisites

Do these **before** the daemon can tailor or submit anything. `npm run doctor` reports each one.

1. **Private repo before `/setup`.** A public GitHub fork of this project stays public. `/setup` writes your name, contact details and employment history into tracked files. Use a private repository with this one as `upstream` ([SETUP.md section 8](../SETUP.md#8-pulling-upstream-updates-into-your-fork)).
2. **`/setup`** in Claude Code so `CLAUDE.md` and `.claude/skills/job-application-assistant/01-candidate-profile.md` no longer contain `[PLACEHOLDER]` tokens.
3. **Standing answers:** copy [`profile/answers.example.json`](profile/answers.example.json) to `profile/answers.json` and fill in contact, work authorisation, salary, notice period, and consent flags. Empty required fields block auto-submit.
4. **LaTeX** (`lualatex` + `xelatex`) so `/autoapply` can compile a 2-page CV and a 1-page cover letter. Or register a Typst template with `/add-template`. See [SETUP.md](../SETUP.md).
5. **Claude Code login** (or `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` for field mapping / outreach drafts). `/autoapply` always uses the Agent SDK.
6. **`APOLLO_API_KEY`** (master key) in `agent/.env` for people search. Search is free; revealing a work email costs 1 credit. Ten people per company ≈ 10 credits.
7. **Gmail:** a Desktop-app OAuth client JSON at `agent/secrets/gmail_credentials.json`, then `npm run cli -- gmail auth`.

## Install and run

```bash
cd agent
cp config.example.json config.json   # first time only
cp .env.example .env                 # then add keys
npm install
npm run doctor
npm start
```

The process listens on `http://127.0.0.1:47831` and prints a **pairing token**. Paste that token into the extension Settings page ([`extension/README.md`](../extension/README.md)).

`config.json` defaults match a fully automatic posture: `autopilot.autoSubmit: true`, `outreach.mode: "auto"`, `peoplePerCompany: 10`. Caps still apply (`maxApplicationsPerDay`, `maxEmailsPerDay`, `minFitToApply` = 60). Flip `autoSubmit` or `outreach.mode` to `"approve"` if you want a queue.

## CLI

```bash
npm run cli -- doctor
npm run cli -- token
npm run cli -- gmail auth
npm run cli -- outreach --company "Acme" --role "ML Engineer" [--domain acme.com] [--people 10] [--send]
npm run cli -- outreach list
npm run cli -- outreach send-pending
npm run cli -- jobs
```

`/outreach` in Claude Code calls this CLI. Do not bypass it with raw Apollo or Gmail curl.

## HTTP API (127.0.0.1 only)

Bearer token required except `/api/health`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/doctor` | prerequisite checks |
| GET/PATCH | `/api/config` | public settings (no secrets) |
| POST | `/api/jobs` | enqueue a posting → `/autoapply` |
| POST | `/api/jobs/:id/map` | form schema → answers + gate |
| GET | `/api/jobs/:id/files/{cv\|cover}` | tailored PDFs |
| POST | `/api/jobs/:id/submitted` | tracker + outreach |
| GET | `/api/tracker` | `job_search_tracker.csv` rows |
| GET | `/api/outreach` | referral queue |
| WS | `/ws?token=...` | `job.updated`, `outreach.updated` |

## Layout

```
agent/
├── src/           # daemon, pipeline, Apollo/Gmail/Claude integrations
├── test/          # unit tests (vitest)
├── profile/       # answers.example.json (copy to answers.json)
├── config.example.json
└── .env.example
```

`config.json`, `state/`, `secrets/`, and `profile/answers.json` are gitignored.
