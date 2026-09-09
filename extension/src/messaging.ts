import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ApplicationJob, FieldAnswer, FormSchema, JobPosting, OutreachTarget, PublicConfig, TrackerRow } from '@protocol';

export interface FilePayload {
  name: string;
  mime: string;
  /** Base64 (standard, not url-safe). */
  base64: string;
}

export interface FillPayload {
  answers: FieldAnswer[];
  files: { cv?: FilePayload; cover?: FilePayload };
}

export interface FillResult {
  filled: number;
  skipped: number;
  errors: string[];
}

export interface SubmitResult {
  submitted: boolean;
  nextClicked?: boolean;
  confirmationText?: string;
  url: string;
}

export interface DetectResult {
  posting: JobPosting | null;
  reason?: string;
}

export interface ProtocolMap {
  detect(): DetectResult;
  scan(): FormSchema;
  fill(data: FillPayload): FillResult;
  submit(data: { force?: boolean }): SubmitResult;
  pageReady(data: { posting: JobPosting | null; tabUrl: string }): void;
  getState(): {
    connected: boolean;
    config?: PublicConfig;
    jobs: ApplicationJob[];
    outreach: OutreachTarget[];
    tracker: TrackerRow[];
    error?: string;
  };
  pair(data: { token: string; daemonUrl?: string }): { ok: boolean; error?: string };
  getPairing(): { token: string; daemonUrl: string };
  enqueue(data: { posting: JobPosting; tabId?: number }): { job: ApplicationJob; created: boolean };
  retryJob(data: { jobId: string }): { job: ApplicationJob };
  submitJob(data: { jobId: string; confirmationText?: string; url: string; mode: 'auto' | 'manual' }): { job: ApplicationJob };
  markReview(data: { jobId: string; reason: string }): { job: ApplicationJob };
  sendOutreach(data: { id: string }): { ok: boolean };
  skipOutreach(data: { id: string }): { ok: boolean };
  startFill(data: { jobId: string; tabId: number; forceSubmit?: boolean }): { ok: boolean; error?: string };
  doctor(): { checks: Array<{ name: string; ok: boolean; detail: string; required: boolean }> };
  patchConfig(data: unknown): PublicConfig;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
