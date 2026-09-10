import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../config.js';
import { logger } from '../log.js';
import { runAgent } from './claude.js';

const log = logger('llm');

export interface StructuredRequest {
  /** Short description of what is being generated (for logs). */
  purpose: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  backend: 'anthropic' | 'agent-sdk';
  costUsd?: number;
}

/**
 * Structured JSON generation with two interchangeable backends:
 *  - direct Anthropic Messages API (needs ANTHROPIC_API_KEY and llm.model)
 *  - Claude Agent SDK with no tools (uses the Claude Code login; slower to start)
 * Both return an object validated only by shape at the call site (zod), never trusted blindly.
 */
export class Llm {
  private anthropic?: Anthropic;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly repoRoot: string,
  ) {}

  backend(): 'anthropic' | 'agent-sdk' {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = this.cfg.llm.model || process.env.ANTHROPIC_MODEL || '';
    if (this.cfg.llm.backend === 'anthropic') {
      if (!key || !model) throw new Error('llm.backend=anthropic requires ANTHROPIC_API_KEY and llm.model');
      return 'anthropic';
    }
    if (this.cfg.llm.backend === 'agent-sdk') return 'agent-sdk';
    return key && model ? 'anthropic' : 'agent-sdk';
  }

  async structured<T>(req: StructuredRequest): Promise<StructuredResult<T>> {
    const backend = this.backend();
    log.info(`structured generation: ${req.purpose}`, { backend });
    if (backend === 'anthropic') return this.viaAnthropic<T>(req);
    return this.viaAgentSdk<T>(req);
  }

  private async viaAnthropic<T>(req: StructuredRequest): Promise<StructuredResult<T>> {
    this.anthropic ??= new Anthropic();
    const model = this.cfg.llm.model || process.env.ANTHROPIC_MODEL!;
    const response = await this.anthropic.messages.create({
      model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      tools: [
        {
          name: 'emit',
          description: 'Return the structured result.',
          input_schema: req.schema as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: 'emit' },
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') throw new Error(`no structured output for ${req.purpose}`);
    return { value: toolUse.input as T, backend: 'anthropic' };
  }

  private async viaAgentSdk<T>(req: StructuredRequest): Promise<StructuredResult<T>> {
    const result = await runAgent({
      cwd: this.repoRoot,
      prompt: req.user,
      systemAppend: req.system,
      outputSchema: req.schema,
      maxTurns: 3,
      projectSettings: false,
      tools: false,
    });
    if (!result.ok || result.output === undefined) {
      throw new Error(`structured generation failed (${req.purpose}): ${result.error ?? 'no output'}`);
    }
    return { value: result.output as T, backend: 'agent-sdk', costUsd: result.costUsd };
  }
}
