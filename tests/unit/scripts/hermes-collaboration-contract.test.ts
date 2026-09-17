import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const handler = readFileSync('adapters/hermes/handler.py', 'utf8');
const gatewayPatch = readFileSync('adapters/hermes/gateway-run.patch', 'utf8');
const sharedContext = readFileSync('src/collab/context.ts', 'utf8');

describe('Hermes collaboration Hook contract', () => {
  it('gates human runs on a real self mention and bot runs on Hub authorization', () => {
    expect(gatewayPatch).toContain('mentioned_bot');
    expect(gatewayPatch).toContain('self._mentions_self(message)');
    expect(gatewayPatch).toContain('"mentions": [');
    expect(handler).toContain('if not bool(context.get("mentioned_bot"))');
    expect(handler).toContain('def _wait_for_dispatch(task_id: str, agent_id: str)');
    expect(handler).toContain('LARK_COLLAB_EVENT_SOURCE", "distributed") == "coordinator"');
    expect(handler).toContain('def _observed_human_targets');
    expect(handler).toContain('context["cancel"] = True');
  });

  it('exposes formal ask and handoff delegation to Hermes', () => {
    expect(handler).toContain('/prompt-context');
    expect(handler).not.toContain('/context?agentId=');
    expect(sharedContext).toContain('<collaboration_handoff target="TARGET_ID">');
    expect(sharedContext).toContain('yourDispatch');
  });

  it('closes the exact accepted dispatch on every terminal path', () => {
    expect(handler).toContain('_RUN_BY_SESSION');
    expect(handler).toContain('"status": "completed"');
    expect(handler).toContain('"status": "failed"');
    expect(handler).toContain('"causedByDispatchId": dispatch_id');
  });
});
