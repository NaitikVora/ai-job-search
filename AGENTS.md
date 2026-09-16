---
framework_version: 1.1.0
---

# Agent Guidelines: AI Job Search

This workspace is structured to manage job search activities, scraper tools, CVs, cover letters, and interview preparation.

## Thin-Pointer Design (Single Source of Truth)

To prevent duplication and configuration drift across different AI agent frameworks (Claude Code, Google Antigravity, Codex, Cursor, Gemini CLI, etc.), this workspace uses a unified thin-pointer design. All agent runtimes should load the canonical specifications and candidate profiles from the files and directories below:

1. **Personal Candidate Profile:**
   - The candidate profile, contact details, education, and target preferences are defined in [CLAUDE.md](CLAUDE.md) and the individual profile methodology files under [.claude/skills/job-application-assistant/](.claude/skills/job-application-assistant/) (specifically `01-*.md` etc.).
2. **Canonical Workflow Specifications:**
   - The step-by-step instructions and triggers for tasks (setup, scrape, rank, apply, upskill, interview) are defined in the [.claude/](.claude/) directory (specifically under `.claude/skills/` and `.claude/commands/`).
   - Do not duplicate these rules or specifications. Treat `.claude/` files as the single source of truth.
3. **Portal Search Skills:**
 - Job-portal search CLIs live under [.agents/skills/](.agents/skills/) in the portable Agent Skills format (with a `SKILL.md` per portal). Codex and Antigravity discover these automatically; the `/scrape` workflow in [.claude/skills/job-scraper/](.claude/skills/job-scraper/) orchestrates them.
4. **Autopilot (browser extension + local daemon):**
 - [extension/](extension/) is a Chrome MV3 extension that detects job postings, scans and fills application forms, and shows the pipeline in a side panel. [agent/](agent/) is the local daemon it talks to. Discovery is the SpeedyApply `NEW_GRAD_USA.md` feed (`npm run cli -- feed` in `agent/`, or the extension Feed tab). When `llm.backend` is `cursor` (the default), this Cursor agent runs `/autoapply` ([.claude/commands/autoapply.md](.claude/commands/autoapply.md)); Claude Code is optional. The daemon maps form fields to grounded answers, gates auto-submit, updates `job_search_tracker.csv`, and can run referral outreach (`/outreach`, rules in `10-referral-outreach.md`). Both reuse the canonical workflow files above rather than duplicating them.
