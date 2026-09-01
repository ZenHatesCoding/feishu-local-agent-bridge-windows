import { extname } from 'node:path';
import { promptSection } from '../agent/prompt';
import type {
  AgentIdentity,
  ContextEntry,
  Dispatch,
  LedgerEvent,
  SharedArtifact,
  TaskProjection,
} from './types';

const RECENT_SEMANTIC_EVENTS = 8;
const MAX_EVENT_EXCERPT_CHARS = 3_000;
const MAX_ARTIFACT_CATALOG_ENTRIES = 20;
const MAX_SELECTED_ARTIFACTS = 8;

interface ArtifactRecord {
  sequence: number;
  actorAgentId: string;
  artifact: SharedArtifact;
}

export function buildCollaborationContext(input: {
  task: TaskProjection;
  dispatch: Dispatch;
  entries: ContextEntry[];
  artifacts?: SharedArtifact[];
  agents?: AgentIdentity[];
}): string {
  const semanticEntries = projectSemanticEntries(input.entries, input.dispatch);
  const artifactRecords = artifactRecordsFor(input.entries, input.artifacts ?? []);
  const selectedArtifactRecords = selectArtifactRecords(
    artifactRecords,
    input.entries,
    input.dispatch,
    input.agents ?? [],
  );
  const catalogRecords = artifactRecords.slice(-MAX_ARTIFACT_CATALOG_ENTRIES);
  const visibleEntryCount = input.entries.length;

  return promptSection('collaboration_context', {
    contract: {
      taskId: input.task.id,
      currentOwner: input.task.ownerAgentId,
      yourDispatch: input.dispatch,
      availableAgents: (input.agents ?? []).map(({ id, displayName }) => ({ id, displayName })),
      rules: [
        'Treat accepted decisions and explicitly selected artifacts as shared task state.',
        'This is a bounded semantic projection, not the complete task ledger. Mechanical routing, lease, dispatch, and acknowledgement events are intentionally omitted.',
        'artifactCatalog is metadata only. Do not open catalog files by path or scan the artifact directory.',
        `Only artifacts in selectedArtifacts are resolved for this objective. To retrieve another artifact on demand, run: collab-artifact.cmd resolve --task ${input.task.id} --actor ${input.dispatch.targetAgentId} --name "<exact catalog name>". Use --list only when the requested file cannot be identified from the catalog.`,
        'Do not expose private runtime traces or chain-of-thought.',
        'To delegate, run: collab-delegate.cmd handoff|ask --target TARGET_ID --content TEXT. It authorizes the Hub action and sends the real Feishu @ in this topic.',
        'Never use a bare lark-cli message or text-only @ to delegate: it cannot authorize work.',
        'For an ask, the target records its answer with hub return, then really @ mentions the current owner.',
        'Complete only the assigned objective and return structured results and artifact paths.',
        `For every task file you create and send, run: collab-artifact.cmd publish --task ${input.task.id} --actor ${input.dispatch.targetAgentId} --path "<absolute-or-relative-path>" --reply-to "<latest bridge_context.messageIds value>" --reply-in-thread. Do not use raw lark-cli --file in a collaboration task.`,
        'Artifacts use locator as the portable source. localPath, when present, is only this node\'s cache. Verify sha256 when integrity matters.',
      ],
    },
    projection: {
      mode: 'bounded-semantic-on-demand-artifacts',
      coveredThroughSequence: input.task.lastSequence,
      visibleEntryCount,
      includedEntrySequences: semanticEntries.map((entry) => entry.sequence),
      omittedVisibleEntryCount: Math.max(0, visibleEntryCount - semanticEntries.length - artifactRecords.length),
      selectedArtifactIds: selectedArtifactRecords.map((record) => record.artifact.id),
      artifactCatalogOmittedCount: Math.max(0, artifactRecords.length - catalogRecords.length),
    },
    artifactCatalog: catalogRecords.map(toArtifactCatalogEntry),
    selectedArtifacts: selectedArtifactRecords.map((record) => ({
      sequence: record.sequence,
      producerAgentId: record.actorAgentId,
      ...record.artifact,
    })),
    entries: semanticEntries,
  });
}

function projectSemanticEntries(entries: ContextEntry[], dispatch: Dispatch): Array<Record<string, unknown>> {
  const semantic = entries.filter(isSemanticEntry).filter((entry) => entry.sequence !== dispatch.sourceSequence);
  const original = semantic.find((entry) => entry.event.kind === 'message');
  const recent = semantic.slice(-RECENT_SEMANTIC_EVENTS);
  const selected = new Map<number, ContextEntry & { event: SemanticEvent }>();
  if (original) selected.set(original.sequence, original);
  for (const entry of recent) selected.set(entry.sequence, entry);
  return [...selected.values()].sort((a, b) => a.sequence - b.sequence).map(toSemanticExcerpt);
}

type SemanticEvent = Extract<LedgerEvent, { kind: 'message' | 'action' | 'task-completed' }>;

function isSemantic(event: LedgerEvent): event is SemanticEvent {
  return event.kind === 'message' || event.kind === 'action' || event.kind === 'task-completed';
}

function isSemanticEntry(entry: ContextEntry): entry is ContextEntry & { event: SemanticEvent } {
  return isSemantic(entry.event);
}

function toSemanticExcerpt(entry: ContextEntry & { event: SemanticEvent }): Record<string, unknown> {
  const event = entry.event;
  if (event.kind === 'message') {
    return {
      sequence: entry.sequence,
      recordedAt: entry.recordedAt,
      kind: event.kind,
      actor: event.actor,
      targetAgentIds: event.targetAgentIds,
      references: event.references,
      ...excerpt(event.content),
    };
  }
  if (event.kind === 'action') {
    return {
      sequence: entry.sequence,
      recordedAt: entry.recordedAt,
      kind: event.kind,
      action: event.action,
      actorAgentId: event.actorAgentId,
      ...(event.targetAgentId ? { targetAgentId: event.targetAgentId } : {}),
      references: event.references,
      ...excerpt(event.content),
    };
  }
  return {
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    kind: event.kind,
    byAgentId: event.byAgentId,
    ...excerpt(event.summary),
  };
}

function excerpt(content: string): { content: string; contentChars: number; excerpted: boolean } {
  if (content.length <= MAX_EVENT_EXCERPT_CHARS) {
    return { content, contentChars: content.length, excerpted: false };
  }
  return {
    content: `${content.slice(0, MAX_EVENT_EXCERPT_CHARS)}\n[excerpt ends here]`,
    contentChars: content.length,
    excerpted: true,
  };
}

function artifactRecordsFor(entries: ContextEntry[], artifacts: SharedArtifact[]): ArtifactRecord[] {
  const byId = new Map<string, ArtifactRecord>();
  for (const entry of entries) {
    if (entry.event.kind !== 'artifact') continue;
    byId.set(entry.event.artifact.id, {
      sequence: entry.sequence,
      actorAgentId: entry.event.actorAgentId,
      artifact: structuredClone(entry.event.artifact),
    });
  }
  for (const artifact of artifacts) {
    if (byId.has(artifact.id)) continue;
    byId.set(artifact.id, { sequence: 0, actorAgentId: 'unknown', artifact: structuredClone(artifact) });
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function selectArtifactRecords(
  records: ArtifactRecord[],
  entries: ContextEntry[],
  dispatch: Dispatch,
  agents: AgentIdentity[],
): ArtifactRecord[] {
  if (records.length === 0) return [];
  const source = entries.find((entry) => entry.sequence === dispatch.sourceSequence);
  const references = source?.event.kind === 'message' || source?.event.kind === 'action'
    ? new Set(source.event.references.map((value) => value.toLocaleLowerCase()))
    : new Set<string>();
  const objective = dispatch.objective.toLocaleLowerCase();
  const exact = records.filter(({ artifact }) =>
    references.has(artifact.id.toLocaleLowerCase()) ||
    references.has(artifact.name.toLocaleLowerCase()) ||
    objective.includes(artifact.id.toLocaleLowerCase()) ||
    objective.includes(artifact.name.toLocaleLowerCase()),
  );
  if (exact.length > 0) return exact.slice(-MAX_SELECTED_ARTIFACTS);

  const requestedKind = artifactKindRequested(objective);
  const hasArtifactPointer = requestedKind !== undefined || /这个文件|该文件|上一版|前一版|之前的版本|交付件|artifact/.test(objective);
  if (!hasArtifactPointer) return [];

  let candidates = requestedKind
    ? records.filter((record) => artifactKind(record.artifact) === requestedKind)
    : records;
  const producer = agents.find(({ id, displayName }) =>
    objective.includes(id.toLocaleLowerCase()) || objective.includes(displayName.toLocaleLowerCase()),
  );
  if (producer) {
    const produced = candidates.filter((record) => record.actorAgentId === producer.id);
    if (produced.length > 0) candidates = produced;
  }
  const wantsAll = /全部|所有|all\s+(?:files|artifacts|pdfs|documents|decks)/.test(objective);
  return wantsAll ? candidates.slice(-MAX_SELECTED_ARTIFACTS) : candidates.slice(-1);
}

function artifactKindRequested(text: string): string | undefined {
  if (/\bpptx?\b|幻灯片|演示稿|演示文稿|deck/.test(text)) return 'presentation';
  if (/\bpdf\b/.test(text)) return 'pdf';
  if (/\bxlsx?\b|excel|电子表格|工作簿/.test(text)) return 'spreadsheet';
  if (/\bdocx?\b|word|文档/.test(text)) return 'document';
  if (/\bpng\b|\bjpe?g\b|图片|图像|截图/.test(text)) return 'image';
  if (/\bmp4\b|视频/.test(text)) return 'video';
  return undefined;
}

function artifactKind(artifact: SharedArtifact): string {
  const extension = extname(artifact.name).toLocaleLowerCase();
  if (extension === '.ppt' || extension === '.pptx') return 'presentation';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.xls' || extension === '.xlsx' || extension === '.csv' || extension === '.tsv') return 'spreadsheet';
  if (extension === '.doc' || extension === '.docx' || extension === '.md' || extension === '.txt') return 'document';
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.gif' || extension === '.webp') return 'image';
  if (extension === '.mp4' || extension === '.mov' || extension === '.webm') return 'video';
  return artifact.kind;
}

function toArtifactCatalogEntry(record: ArtifactRecord): Record<string, unknown> {
  return {
    id: record.artifact.id,
    sequence: record.sequence,
    producerAgentId: record.actorAgentId,
    name: record.artifact.name,
    kind: artifactKind(record.artifact),
    size: record.artifact.size,
    ...(record.artifact.mime ? { mime: record.artifact.mime } : {}),
  };
}
