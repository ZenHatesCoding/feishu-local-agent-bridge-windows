import { describe, expect, it } from 'vitest';
import { parseStreamJsonLine } from '../../../src/agent/antigravity/adapter.js';

describe('Antigravity stream-json activity', () => {
  it('uses the final structured memory object instead of concatenating draft JSON', () => {
    expect(parseStreamJsonLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '{"draft":1}' } }), true)).toEqual({});
    const candidate = { items: [], summary: 'corrected requirement' };
    expect(parseStreamJsonLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"draft":1}\n{"draft":2}', structured_output: candidate } }), true)).toEqual({ finalText: JSON.stringify(candidate) });
  });
  it('preserves final text and errors', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', text_delta: 'done' },
    }))).toEqual({ delta: 'done' });
    expect(parseStreamJsonLine(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'error_message', text_delta: 'failed' },
    }))).toEqual({ error: 'failed' });
  });

  it('turns non-text steps into privacy-safe activity heartbeats', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'tool_execution', tool_name: 'private-tool' },
    }))).toEqual({ activity: 'agent stream active' });
  });

  it('does not manufacture activity after the terminal result', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'done' },
    }))).toEqual({ finalText: 'done' });
  });
});
