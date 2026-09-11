import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { SharedArtifact } from './types';

export interface SnapshotArtifactInput {
  sourcePath: string;
  root: string;
  taskId: string;
  originalName?: string;
  kind?: string;
  mime?: string;
  sourceMessageId?: string;
  sourceFileKey?: string;
}

export type MaterializedArtifact = SharedArtifact & { localPath: string };

export async function snapshotArtifact(input: SnapshotArtifactInput): Promise<MaterializedArtifact> {
  const sourceStat = await stat(input.sourcePath);
  if (!sourceStat.isFile()) throw new Error(`artifact source is not a file: ${input.sourcePath}`);
  const sha256 = await hashFile(input.sourcePath);
  const name = safeName(input.originalName ?? basename(input.sourcePath));
  const artifactDir = join(input.root, safeSegment(input.taskId), sha256);
  const localPath = join(artifactDir, name);
  await mkdir(artifactDir, { recursive: true });
  try {
    const existing = await stat(localPath);
    if (!existing.isFile() || existing.size !== sourceStat.size) throw new Error('artifact snapshot mismatch');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const tempPath = `${localPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await copyFile(input.sourcePath, tempPath);
      await rename(tempPath, localPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
  return {
    id: `artifact_${sha256.slice(0, 24)}`,
    name,
    kind: input.kind ?? kindFromName(name),
    localPath,
    locator: input.sourceMessageId && input.sourceFileKey
      ? { provider: 'feishu', messageId: input.sourceMessageId, fileKey: input.sourceFileKey }
      : { provider: 'local', path: localPath },
    sha256,
    size: sourceStat.size,
    ...(input.mime ? { mime: input.mime } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.sourceFileKey ? { sourceFileKey: input.sourceFileKey } : {}),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'task';
}

function safeName(value: string): string {
  const clean = basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return (clean || 'artifact.bin').slice(0, 180);
}

function kindFromName(name: string): string {
  const ext = extname(name).toLowerCase();
  if (['.ppt', '.pptx', '.key'].includes(ext)) return 'presentation';
  if (['.doc', '.docx', '.md', '.txt'].includes(ext)) return 'document';
  if (['.xls', '.xlsx', '.csv', '.tsv'].includes(ext)) return 'spreadsheet';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}
