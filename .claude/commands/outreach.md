# /outreach - Referral Outreach (Apollo people search + Gmail)

You are helping the candidate ask current employees of a target company for a referral or a short conversation about a role they applied to (or are about to apply to). The rules live in `.claude/skills/job-application-assistant/10-referral-outreach.md` - **read that file first** and follow it. The mechanics live in the autopilot daemon package `agent/`, whose CLI you call through Bash; the CLI enforces the caps, the cooldowns and the dedup log, so never bypass it with ad-hoc curl calls to Apollo or Gmail.

## Arguments

`$ARGUMENTS` is one of:

- `<company> [| <role>] [--people N] [--send] [--domain <company domain>]` - find and draft (and, with `--send`, send) referral requests for one company. If the role is omitted, look it up in `job_search_tracker.csv` (the most recent open or applied row for that company) and confirm which one you used in your report.
- `list` - show the outreach log (every person contacted, status, follow-ups).
- `send-pending` - send drafts that are waiting in the queue (mode `approve` workflow).
- `follow-ups` - run the follow-up pass now: mark threads with replies, send at most one polite follow-up to the others whose due date has passed.

## Step 0: Prerequisites

Run `cd agent && npm run cli -- doctor` and check the lines `APOLLO_API_KEY`, `Gmail credentials`, `Gmail authorized`. If Apollo is missing, stop and tell the user how to add the key (`agent/.env`, see `agent/README.md`). If Gmail is not authorized, drafting still works; tell the user that sending needs `npm run cli -- gmail auth` first.

The Bash calls in this command are **intentionally not pre-approved** in `.claude/settings.json`: they can send email from the user's account, so the permission prompt is the point.

## Step 1: Find, rank, draft

```bash
cd agent && npm run cli -- outreach --company "<company>" --role "<role>" [--domain <domain>] [--people N] [--url <posting url>] [--summary "<one-paragraph posting summary>"]
```

Without `--send` the CLI runs in `approve` mode: it searches Apollo (free), enriches the best-ranked people (1 credit each; the summary reports `creditsSpent`), drafts one email and one LinkedIn note per person in the candidate's writing style, and stores them as `drafted`. Pass `--summary` when you have the posting text at hand (from `documents/applications/<slug>/job_posting.md`), so the drafts can name something concrete about the role.

Then read `agent/state/outreach.json` (or run `... outreach list`) and present the new drafts as a table: name, title, relevance, email present or LinkedIn-only, subject line. Show one or two full email bodies so the user can judge the voice. Apply the review rules in `10-referral-outreach.md` (grounding, length, tone) and fix a draft with `PATCH`-equivalent edits only by re-running with a better `--summary` or by editing `agent/state/outreach.json` fields `emailSubject` / `emailBody` / `linkedinNote` in place - never invent facts about the candidate to make a draft stronger.

## Step 2: Send or queue

- If the user asked for `--send`, or approves the whole queue, run `cd agent && npm run cli -- outreach send-pending`. To send or drop individual drafts use `... outreach send --id <id>` and `... outreach skip --id <id>` (ids are in `agent/state/outreach.json`). Report how many went out, which were capped (daily or per-company), and which failed.
- For every target with a `linkedinUrl`, list the URL together with its `linkedinNote`. **These are never sent automatically** - LinkedIn's User Agreement (section 8.2) forbids automated messaging and accounts get restricted for it. The candidate opens the profile and pastes the note by hand.
- Remind the user that replies land in their own Gmail; when a reply turns into an interview or a referral, `/outcome <company>` records it.

## Step 3: Report

End with: people found, enriched, drafted, sent, Apollo credits spent this run, the LinkedIn hand-off list, and the next follow-up date (`followUpDueAt` on the sent targets). Keep it to one screen.
