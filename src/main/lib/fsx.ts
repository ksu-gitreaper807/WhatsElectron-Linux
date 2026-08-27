/** Small filesystem helpers for diagnostics. Bounded, never throws. */

import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface DirectoryStats {
  readonly bytes: number | null;
  readonly files: number;
  readonly truncated: boolean;
  readonly error: string | null;
}

/**
 * Recursive size of a directory with hard caps.
 *
 * Used for "how big is my login profile" in the settings window. The caps
 * matter: the session directory can hold tens of thousands of small files, and a
 * diagnostics helper must not become a CPU/IO incident.
 */
export async function directoryStats(dir: string, maxFiles = 20_000, maxDepth = 8): Promise<DirectoryStats> {
  let bytes = 0;
  let files = 0;
  let truncated = false;

  const walk = async (current: string, depth: number): Promise<boolean> => {
    if (depth > maxDepth) {
      truncated = true;
      return true;
    }
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(current);
    } catch {
      return false;
    }
    for await (const entry of handle) {
      if (files >= maxFiles) {
        truncated = true;
        return true;
      }
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (await walk(target, depth + 1)) return true;
        continue;
      }
      if (entry.isFile()) {
        try {
          const info = await stat(target);
          bytes += info.size;
          files += 1;
        } catch {
          /* raced with a delete; ignore */
        }
      }
    }
    return false;
  };

  try {
    const hit = await walk(dir, 0);
    return { bytes, files, truncated: hit === true || truncated, error: null };
  } catch (error: unknown) {
    return {
      bytes: null,
      files,
      truncated,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
