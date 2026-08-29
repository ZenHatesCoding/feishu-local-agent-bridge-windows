import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const handler = readFileSync('adapters/hermes/handler.py', 'utf8');
const gatewayPatch = readFileSync('adapters/hermes/gateway-run.patch', 'utf8');

describe('Hermes collaboration Hook contract', () => {
  it('gates human runs on a real self mention and bot runs on Hub authorization', () => {
    expect(gatewayPatch).toContain('mentioned_bot');
    expect(gatewayPatch).toContain('self._mentions_self(message)');
    expect(handler).toContain('if not bool(context.get("mentioned_bot"))');
    expect(handler).toContain('return _pending_dispatch(task_id, agent_id)');
    expect(handler).toContain('context["cancel"] = True');
  });

  it('exposes formal ask and handoff delegation to Hermes', () => {
    expect(handler).toContain('_request("/v1/agents")');
    expect(handler).toContain('collab-delegate.cmd ask|handoff');
    expect(handler).toContain('--caused-by-dispatch');
  });

  it('closes the exact accepted dispatch on every terminal path', () => {
    expect(handler).toContain('_RUN_BY_SESSION');
    expect(handler).toContain('"status": "completed"');
    expect(handler).toContain('"status": "failed"');
    expect(handler).toContain('"causedByDispatchId": dispatch_id');
  });
});
