/**
 * Shared wire types between the Chrome extension and the local autopilot daemon.
 *
 * This file is the single source of truth: the extension imports it through a
 * path alias (`@protocol` -> `../agent/src/protocol.ts`). Keep it free of
 * Node-only or DOM-only imports so it compiles in both worlds.
 */

// ---------------------------------------------------------------------------
// Job postings
// ---------------------------------------------------------------------------

/** Which ATS / job board a page belongs to. `unknown` still gets the generic adapter. */
export type AtsKind =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'smartrecruiters'
  | 'icims'
  | 'linkedin'
  | 'indeed'
  | 'unknown';

/** A job posting as extracted by the extension's content script. */
export interface JobPosting {
  /** Canonical posting URL (the page the posting was detected on). */
  url: string;
  /** URL of the application form if it differs from `url` (e.g. LinkedIn -> external ATS). */
  applyUrl?: string;
  ats: AtsKind;
  title: string;
  company: string;
  location?: string;
  /** Plain-text posting body, verbatim. Treated as untrusted input everywhere. */
  description: string;
  /** ISO date if the posting states an application deadline. Never inferred. */
  deadline?: string;
  /** ISO date the posting was published, if available. */
  datePosted?: string;
  /** BCP-47 language tag guessed from the page (`en`, `da`, ...). */
  language?: string;
  /** Employer website domain if discoverable on the page (used to target Apollo searches). */
  companyDomain?: string;
  /** How the extraction was obtained, for debugging. */
  source: 'jsonld' | 'adapter' | 'heuristic' | 'manual';
  /** Whether the posting page itself contains the application form. */
  hasInlineForm: boolean;
  /** True when the only apply path is LinkedIn Easy Apply (never automated). */
  easyApplyOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Application job lifecycle (one job = one posting being applied to)
// ---------------------------------------------------------------------------

export type JobState =
  | 'queued'
  | 'tailoring' // Claude Agent SDK is running /autoapply (evaluate + draft + compile + verify)
  | 'skipped' // below fit threshold / gate FAIL / deal-breaker / daily cap
  | 'ready' // documents + form answers ready; waiting for the extension to fill the form
  | 'filling'
  | 'needs_review' // filled but a gate blocked auto-submit; human must click submit
  | 'submitted'
  | 'failed';

export interface FitSummary {
  overall: number; // 0-100, the tracker's fit_rating
  verdict: string; // "Strong Fit" | "Good Fit" | "Moderate Fit" | "Weak Fit" | "Poor Fit"
  technical?: number;
  experience?: number;
  behavioral?: number;
  career?: number;
  locationGate: 'PASS' | 'FAIL' | 'FLAG';
  languageGate: 'PASS' | 'FAIL' | 'FLAG';
  dealBreakers: string[];
  strengths: string[];
  gaps: string[];
}

export interface GeneratedFiles {
  cvSource?: string; // repo-relative path, e.g. cv/main_acme_ml_engineer.tex
  cvPdf?: string;
  coverSource?: string;
  coverPdf?: string;
  formFieldsTxt?: string; // documents/applications/<slug>/application_fields.txt
  resultJson?: string; // documents/applications/<slug>/autoapply_result.json
}

/** A pre-drafted answer to a free-text question, produced by /autoapply per 08-application-forms.md. */
export interface DraftedAnswer {
  question: string;
  answer: string;
  shortAnswer?: string;
  wordCount?: number;
}

/** The structured result /autoapply returns (also written to documents/applications/<slug>/autoapply_result.json). */
export interface AutoapplyResult {
  company: string;
  role: string;
  slug: string;
  location?: string;
  deadline?: string | null;
  postingLanguage?: string;
  fit: FitSummary;
  proceeded: boolean;
  skipReason?: string;
  files: GeneratedFiles;
  formAnswers: DraftedAnswer[];
  verification: {
    cvPages?: number;
    coverPages?: number;
    atsOk?: boolean;
    notes: string[];
  };
  trackerRowWritten: boolean;
}

export interface ApplicationJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;
  posting: JobPosting;
  /** Tab that owns this job in the extension (informational for the daemon). */
  tabId?: number;
  result?: AutoapplyResult;
  fit?: FitSummary;
  files?: GeneratedFiles;
  formAnswers?: DraftedAnswer[];
  /** Populated when the form was filled: the gate decision explaining auto-submit or review. */
  gate?: GateDecision;
  submittedAt?: string;
  submissionUrl?: string;
  error?: string;
  /** Total Agent SDK cost in USD for this job (estimate). */
  costUsd?: number;
  /** Progress log lines for the side panel. */
  log: JobLogEntry[];
}

export interface JobLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Form schema (extension -> daemon) and answers (daemon -> extension)
// ---------------------------------------------------------------------------

export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select' // native <select> or custom dropdown with enumerable options
  | 'combobox' // typeahead / autocomplete where options load as you type
  | 'radio'
  | 'checkbox' // single boolean checkbox
  | 'checkbox-group'
  | 'file'
  | 'hidden'
  | 'unknown';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FormField {
  /** Stable id assigned by the scanner (data attribute written onto the element). */
  id: string;
  kind: FieldKind;
  /** Best-effort human label (label[for], aria-label, legend, placeholder, nearby text). */
  label: string;
  /** Extra context: help text, section heading, fieldset legend. */
  context?: string;
  name?: string;
  placeholder?: string;
  required: boolean;
  options?: FieldOption[];
  currentValue?: string;
  maxLength?: number;
  /** For file inputs: the accept attribute. */
  accept?: string;
  /** Adapter-specific hint, e.g. Workday data-automation-id. */
  automationId?: string;
}

export interface FormSchema {
  url: string;
  ats: AtsKind;
  /** 1-based step for multi-page forms, when known. */
  step?: number;
  stepLabel?: string;
  fields: FormField[];
  /** True if a CAPTCHA widget was detected on the page. Auto-submit is never attempted then. */
  captchaDetected: boolean;
  /** Text of the submit/next button, for the log. */
  submitLabel?: string;
}

export type FieldAnswerValue =
  | { type: 'text'; value: string }
  | { type: 'option'; value: string; label?: string } // select/radio/combobox: choose the option whose value or label matches
  | { type: 'options'; values: string[] } // checkbox-group
  | { type: 'boolean'; value: boolean }
  | { type: 'file'; file: 'cv' | 'cover' } // extension fetches the PDF from the daemon
  | { type: 'skip'; reason: string };

export interface FieldAnswer {
  fieldId: string;
  answer: FieldAnswerValue;
  /** 0-1. Below the configured threshold the field is flagged for review. */
  confidence: number;
  /** Where the value came from, for the review UI. */
  source: 'profile' | 'answers' | 'drafted' | 'posting' | 'inferred' | 'none';
  note?: string;
}

export interface MapFieldsResponse {
  answers: FieldAnswer[];
  /** Fields the model could not answer with enough confidence. */
  unresolved: Array<{ fieldId: string; label: string; required: boolean; reason: string }>;
  gate: GateDecision;
}

export interface GateDecision {
  autoSubmit: boolean;
  reasons: string[];
  minFit: number;
  fit?: number;
  unresolvedRequired: number;
  lowConfidence: number;
  captcha: boolean;
  dailyCapReached: boolean;
}

// ---------------------------------------------------------------------------
// Submission report (extension -> daemon)
// ---------------------------------------------------------------------------

export interface SubmissionReport {
  jobId: string;
  submittedAt: string;
  url: string;
  /** Confirmation text captured from the page, if any. */
  confirmationText?: string;
  /** Whether the click was automatic or a human pressed submit in the review UI. */
  mode: 'auto' | 'manual';
}

// ---------------------------------------------------------------------------
// Referral outreach
// ---------------------------------------------------------------------------

export type OutreachStatus =
  | 'drafted' // waiting for approval (mode=approve) or for the sender loop (mode=auto)
  | 'sent'
  | 'replied'
  | 'followed_up'
  | 'skipped'
  | 'failed';

export interface OutreachTarget {
  id: string;
  jobId?: string;
  company: string;
  role: string;
  slug: string;
  personId?: string; // Apollo id
  name: string;
  title: string;
  email?: string;
  emailStatus?: string; // verified | guessed | unavailable ...
  linkedinUrl?: string;
  /** Why this person was chosen (peer / hiring manager / recruiter / alum ...). */
  relevance: string;
  relevanceScore: number;
  emailSubject?: string;
  emailBody?: string;
  /** <= 300 chars. Never sent automatically; the side panel opens the profile and copies it. */
  linkedinNote?: string;
  status: OutreachStatus;
  createdAt: string;
  sentAt?: string;
  gmailThreadId?: string;
  gmailMessageId?: string;
  followUpDueAt?: string;
  followUpsSent: number;
  error?: string;
}

export interface OutreachRunSummary {
  jobId?: string;
  company: string;
  role: string;
  found: number;
  enriched: number;
  drafted: number;
  sent: number;
  skipped: number;
  creditsSpent: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Daemon configuration exposed to the extension (no secrets)
// ---------------------------------------------------------------------------

export interface PublicConfig {
  autopilot: {
    enabled: boolean;
    autoSubmit: boolean;
    minFitToApply: number;
    minFieldConfidence: number;
    maxApplicationsPerDay: number;
  };
  outreach: {
    mode: 'auto' | 'approve' | 'off';
    peoplePerCompany: number;
    maxEmailsPerDay: number;
  };
  repoRoot: string;
  version: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket events (daemon -> extension)
// ---------------------------------------------------------------------------

export type DaemonEvent =
  | { type: 'job.updated'; job: ApplicationJob }
  | { type: 'job.log'; jobId: string; entry: JobLogEntry }
  | { type: 'outreach.updated'; target: OutreachTarget }
  | { type: 'config.updated'; config: PublicConfig }
  | { type: 'hello'; version: string };

// ---------------------------------------------------------------------------
// Tracker rows (mirrors job_search_tracker.csv header exactly)
// ---------------------------------------------------------------------------

export const TRACKER_HEADER = [
  'date',
  'company',
  'sector',
  'role',
  'role_type',
  'channel',
  'status',
  'contact_person',
  'fit_rating',
  'notes',
  'cv_file',
  'cover_letter_file',
  'source',
  'deadline',
] as const;

export type TrackerColumn = (typeof TRACKER_HEADER)[number];
export type TrackerRow = Record<TrackerColumn, string>;

/** Final statuses per /outcome's Tracker status vocabulary (legacy space spellings accepted on read). */
export const FINAL_STATUSES = new Set([
  'hired',
  'rejected',
  'no_response',
  'no response',
  'offer_declined',
  'offer declined',
  'withdrawn',
]);
