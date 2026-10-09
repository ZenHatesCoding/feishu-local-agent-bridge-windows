import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import type { LanFakeAgentScript, LanFakeAgentStep } from './types';

export type FakeAgentStep = LanFakeAgentStep;
export type FakeAgentScript = LanFakeAgentScript;

/**
 * Deterministic in-process agent used by the simulation harness and tests.
 * It satisfies the real AgentAdapter contract, so the worker pipeline treats
 * it exactly like codex or claude.
 */
export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  private readonly script: FakeAgentScript | undefined;

  constructor(options: { id?: string; displayName?: string; script?: FakeAgentScript } = {}) {
    this.id = options.id ?? 'fake';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.script = options.script;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  run(opts: AgentRunOptions): AgentRun {
    const steps = this.script?.steps ?? this.defaultSteps(opts.prompt);
    // Stop flag is per-run: a cancelled run must not poison the adapter for
    // the worker's next dispatch.
    const stopping = { value: false };
    const events = this.stream(steps, stopping);
    return {
      runId: opts.runId,
      events,
      stop: async () => {
        stopping.value = true;
      },
      waitForExit: async (timeoutMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 25)));
        return !stopping.value;
      },
    };
  }

  private async *stream(steps: FakeAgentStep[], stopping: { value: boolean }): AsyncGenerator<AgentEvent> {
    yield { type: 'system', sessionId: `fake-${randomUUID().slice(0, 8)}` };
    for (const step of steps) {
      if (stopping.value) {
        yield { type: 'error', message: 'fake agent stopped', terminationReason: 'interrupted' };
        return;
      }
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.status) yield { type: 'activity', summary: step.status };
      if (step.text) yield { type: 'text', delta: step.text };
      if (step.tool) {
        yield { type: 'tool_use', id: step.tool.id, name: step.tool.name, input: step.tool.input ?? {} };
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, (step.delayMs ?? 20) / 2)));
        yield { type: 'tool_result', id: step.tool.id, output: step.tool.result, isError: step.tool.isError ?? false };
      }
      if (step.finalText !== undefined) yield { type: 'text', delta: step.finalText };
    }
    yield { type: 'usage', inputTokens: 12, outputTokens: 34 };
    yield { type: 'done', terminationReason: 'normal' };
  }

  private defaultSteps(prompt: string): FakeAgentStep[] {
    const lastParagraph = prompt.trim().split(/\n\s*\n/).filter(Boolean).pop() ?? prompt;
    return [
      { delayMs: 10, status: 'reading the conversation context' },
      { delayMs: 10, text: `Received: ${lastParagraph.slice(-400)}` },
    ];
  }
}

/** Parse a fake-agent script JSON (used by the CLI runtime). */
export function parseFakeAgentScript(text: string): FakeAgentScript {
  const parsed = JSON.parse(text) as FakeAgentScript;
  if (!parsed || !Array.isArray(parsed.steps)) throw new Error('fake agent script needs a steps[] array');
  return parsed;
}
