// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';
export { reportMetric, reportError } from './core/logger';

export { CollaborationHub } from './collab/hub';
export { JsonlLedger } from './collab/ledger';
export { CollaborationHubServer } from './collab/server';
export { CollaborationClient } from './collab/client';
export { BridgeCollaborationAdapter, bridgeCollaborationFromEnv } from './collab/bridge-adapter';
export {
  coordinatorInputForMessage,
  resolveMentionedAgents,
  startFeishuCoordinator,
} from './collab/coordinator';
export { buildCollaborationContext } from './collab/context';
export { taskIdFor, validateTaskAddress } from './collab/task-id';
export type {
  ActionInput,
  AgentRegistration,
  ContextEntry,
  ContextVisibility,
  Dispatch,
  HubInput,
  HubResult,
  MessageInput,
  TaskAddress,
  TaskProjection,
} from './collab/types';
