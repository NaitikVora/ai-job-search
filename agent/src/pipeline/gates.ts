import type { AgentConfig } from '../config.js';
import type { FieldAnswer, FormSchema, GateDecision } from '../protocol.js';

export interface GateInput {
  cfg: AgentConfig;
  form: FormSchema;
  answers: FieldAnswer[];
  fit?: number;
  submittedToday: number;
  profilePopulated: boolean;
}

/**
 * The auto-submit gate. Every reason is recorded so the side panel can show exactly why a
 * form was left for review. "Best application ever" is enforced here as: never submit a form
 * with an unanswered required field, a low-confidence guess, a CAPTCHA, or a below-threshold fit.
 */
export function decideGate(input: GateInput): GateDecision {
  const { cfg, form, answers } = input;
  const reasons: string[] = [];
  const byId = new Map(answers.map((a) => [a.fieldId, a]));

  let unresolvedRequired = 0;
  let lowConfidence = 0;
  for (const f of form.fields) {
    if (f.kind === 'hidden') continue;
    const a = byId.get(f.id);
    const skipped = !a || a.answer.type === 'skip';
    if (f.required && skipped) unresolvedRequired++;
    if (a && !skipped && a.confidence < cfg.autopilot.minFieldConfidence) lowConfidence++;
  }

  const dailyCapReached = input.submittedToday >= cfg.autopilot.maxApplicationsPerDay;
  const minFit = cfg.autopilot.minFitToApply;

  if (!cfg.autopilot.enabled) reasons.push('autopilot disabled in config');
  if (!cfg.autopilot.autoSubmit) reasons.push('autoSubmit disabled in config');
  if (!input.profilePopulated) reasons.push('candidate profile still has placeholders; run /setup first');
  if (form.captchaDetected) reasons.push('CAPTCHA detected on the form');
  if (input.fit === undefined) reasons.push('no fit score available');
  else if (input.fit < minFit) reasons.push(`fit ${input.fit} below threshold ${minFit}`);
  if (unresolvedRequired > 0) reasons.push(`${unresolvedRequired} required field(s) unanswered`);
  if (lowConfidence > 0) reasons.push(`${lowConfidence} field(s) below confidence ${cfg.autopilot.minFieldConfidence}`);
  if (dailyCapReached) reasons.push(`daily cap of ${cfg.autopilot.maxApplicationsPerDay} applications reached`);
  if (cfg.autopilot.reviewOnlyAts.includes(form.ats)) reasons.push(`${form.ats} is configured as review-only`);

  return {
    autoSubmit: reasons.length === 0,
    reasons,
    minFit,
    fit: input.fit,
    unresolvedRequired,
    lowConfidence,
    captcha: form.captchaDetected,
    dailyCapReached,
  };
}
