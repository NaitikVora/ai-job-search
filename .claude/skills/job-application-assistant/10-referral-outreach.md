---
framework_version: 1.0.0
---

# Referral Outreach

Referred candidates are consistently interviewed at a far higher rate than cold portal submissions, and asking for the referral is the one part of applying that most candidates skip because it is awkward. This file governs how the autopilot (`agent/`, triggered after a submission) and the `/outreach` command find people and what they are allowed to say and do. The mechanics are enforced in code; these are the rules the code implements and the judgment calls it leaves to Claude.

## Who to contact, and how many

Per company, in this priority:

1. **Peers** - people with the same or an adjacent title to the posted role, ideally on the team the posting describes. They know whether the role is real, what the bar is, and their referral carries weight because they would work with the hire.
2. **The likely hiring manager** - the manager / head / director of the department the role sits in. Ask for a conversation about the role, not for a referral.
3. **A recruiter or talent partner** - one is enough. Ask whether the role is still open and how best to apply; mention the referral you are seeking from the team.

Defaults: up to **10 people per company** (configurable, `outreach.peoplePerCompany`), hard caps of **10 emails per company** and **20 per day**, a **30-day cooldown** per company, and one person is never contacted twice across applications (dedup on Apollo id and email in `agent/state/outreach.json`). Ten is the ceiling, not the target: three well-chosen peers plus one manager and one recruiter usually beats ten generic emails, and every enrichment costs an Apollo credit.

Skip: interns and students, executives above director level for a peer ask, people who left the company (Apollo `employment_history` shows it), anyone the candidate already knows personally (they should write themselves).

## What a message may contain

The same grounding rule as every other artifact in this repo: **every claim about the candidate must be true and traceable to `01-candidate-profile.md`, the master CV, or CLAUDE.md's Candidate Profile.** No invented shared history ("we both went to..."), no inflated titles, no claims about the recipient beyond their public title and company.

Structure of the email (80-120 words, plain text, `03-writing-style.md` applies - no em-dashes, no cliches, no hedging):

1. Greeting by first name.
2. One sentence: who the candidate is (current role or status, one distinguishing fact).
3. One or two sentences: why *this* role at *this* company, naming something concrete from the posting or verified company research. Generic praise reads as spam and gets treated as such.
4. The ask, sized to the recipient: peers -> "would you be open to referring me, or to a 15-minute chat about the team?"; hiring managers -> a short conversation about the role; recruiters -> confirm the role is open and how best to apply.
5. "CV attached" when it is (the daemon attaches the tailored CV PDF by default), sign-off with name and LinkedIn URL.

Subject lines are specific and under 60 characters ("Referral for Data Engineer at Acme?"). Each message is tailored to the recipient's title; identical bodies to several people at one company are a defect.

The LinkedIn note is a separate, shorter text (under 280 characters) for a connection request, written to be pasted by hand.

## What is automated and what is not

| Action | Automated? | Why |
|---|---|---|
| Finding people (Apollo People Search) | Yes | Public API, no credits, ToS-compliant use of a paid data product |
| Revealing work emails (Apollo enrichment) | Yes, capped | 1 credit per email; the free plan has 75 credits a month, so ten people per application is about seven applications a month before a paid plan is needed |
| Drafting emails and LinkedIn notes | Yes | Grounded generation in the candidate's voice, reviewed by the rules above |
| Sending emails from the candidate's Gmail | Yes in `auto` mode, after approval in `approve` mode | The candidate chose full automation; caps and dedup limit the blast radius |
| One follow-up after 7 days if no reply | Yes, at most one | Polite persistence; a second nudge is where it turns into pestering |
| Sending LinkedIn messages or connection requests | **Never** | LinkedIn User Agreement section 8.2 prohibits automated messaging; enforcement in 2026 restricts or closes accounts. The account is the candidate's most valuable job-search asset. The daemon only opens the profile and copies the note. |
| Scraping LinkedIn for people | **Never** | Same clause. People come from Apollo; LinkedIn URLs come from Apollo's enrichment record. |

## Etiquette the code enforces

- Stop the moment someone replies: the follow-up pass checks the Gmail thread and marks the target `replied` instead of nudging.
- Never send to personal email addresses (the enrichment call does not request them) and never reveal phone numbers.
- Honour any "please do not contact me" reply immediately: mark the person `skipped`, and add their company to a manual do-not-contact note in `agent/config.json` if they ask on behalf of the team.
- One company at a time per application; a second application to the same company inside the cooldown reuses the existing conversation rather than opening a new one.

## Privacy

The people contacted are third parties. Their names, titles and work emails live in `agent/state/outreach.json` and the mirror `outreach/outreach_log.csv`, both gitignored. Keep them there: never paste the log into a commit, an issue, or a public place. If someone asks to be forgotten, delete their entry from both files.

## When a reply arrives

- A referral or an interview invitation: record it with `/outcome <company>` (it moves the tracker row and starts the interview record); `/interview` builds the prep pack.
- A "the role is closed" reply: `/outcome <company>` with `withdrawn` or `rejected` as appropriate, and stop any pending follow-up for that company.
- Silence after the follow-up: leave it. The application itself is still in flight; `/outcome followup` handles the employer side.
