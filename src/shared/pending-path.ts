import path from 'node:path';

export const PENDING_FILE_PREFIX = 'lilt-chunk-';

/**
 * Only files this app wrote into its own temp directory may be read or
 * deleted. Shared by every retention IPC handler.
 */
export function isPendingChunkPath(
  tempDir: string,
  candidate: string,
): boolean {
  const root = path.resolve(tempDir);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(root + path.sep)) return false;
  const name = path.basename(resolved);
  return (
    name.startsWith(PENDING_FILE_PREFIX) &&
    (name.endsWith('.webm') || name.endsWith('.json'))
  );
}
