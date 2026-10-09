import { mkdirSync, createWriteStream, createReadStream, statSync, existsSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { LanStoredFile } from './types';
import { sha256Hex } from './auth';

export interface SavedLanFile extends LanStoredFile {
  /** Absolute path of the stored blob on the center. */
  absolutePath: string;
}

/**
 * Content-addressed file store under the center's data directory:
 * `files/<sha256-prefix>/<sha256>` blobs plus a sidecar name, metadata lives
 * in the LanStore `files` table. Local disk only — never NFS/SMB.
 */
export class LanFileStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  rootDir(): string {
    return this.root;
  }

  /**
   * Persist an uploaded buffer and return its metadata. The caller owns the
   * LanStore row (`store.saveFile`), this class only manages blobs.
   */
  async save(input: {
    id: string;
    name: string;
    mime: string;
    content: Buffer;
    uploadedBy: string;
    createdAt: string;
  }): Promise<SavedLanFile> {
    const sha256 = sha256Hex(input.content);
    const shard = sha256.slice(0, 2);
    const dir = join(this.root, shard);
    mkdirSync(dir, { recursive: true });
    const blobPath = join(dir, sha256);
    if (!existsSync(blobPath)) {
      const tmpPath = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
      await pipeline(
        (async function* () { yield input.content; })(),
        createWriteStream(tmpPath, { mode: 0o600 }),
      );
      renameSync(tmpPath, blobPath);
    }
    return {
      id: input.id,
      name: sanitizeFileName(input.name),
      mime: input.mime || 'application/octet-stream',
      size: input.content.length,
      sha256,
      uploadedBy: input.uploadedBy,
      createdAt: input.createdAt,
      absolutePath: blobPath,
    };
  }

  /** Verify a stored blob still matches its recorded digest before delivery. */
  verify(blobPath: string, expectedSha256: string): boolean {
    if (!existsSync(blobPath)) return false;
    return sha256Hex(readFileSync(blobPath)) === expectedSha256;
  }

  openReadStream(blobPath: string) {
    return createReadStream(blobPath);
  }

  statSize(blobPath: string): number {
    return statSync(blobPath).size;
  }

  remove(blobPath: string): void {
    rmSync(blobPath, { force: true });
  }
}

export function sanitizeFileName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'unnamed';
  // Reject path separators and reserved Windows device names; keep the rest.
  const base = trimmed.replace(/[\\/:*?"<>|]/g, '_');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base.split('.')[0] ?? '')
    ? `_${base}`
    : base;
}
