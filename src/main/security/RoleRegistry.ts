/**
 * Which web contents belongs to which part of the application.
 *
 * Every privileged decision ("may this sender read settings?") is answered from
 * this registry, keyed by `webContents.id`, instead of trusting anything the
 * renderer sends us.
 */

import type { WebContents } from 'electron';

export type WindowRole = 'whatsapp' | 'settings';

export class RoleRegistry {
  readonly #roles = new Map<number, WindowRole>();

  register(contents: WebContents, role: WindowRole): () => void {
    this.#roles.set(contents.id, role);
    const cleanup = (): void => {
      this.#roles.delete(contents.id);
    };
    contents.once('destroyed', cleanup);
    return cleanup;
  }

  of(contents: WebContents | null): WindowRole | null {
    if (contents === null) return null;
    return this.#roles.get(contents.id) ?? null;
  }

  ofId(webContentsId: number): WindowRole | null {
    return this.#roles.get(webContentsId) ?? null;
  }

  idsFor(role: WindowRole): number[] {
    const out: number[] = [];
    for (const [id, value] of this.#roles) if (value === role) out.push(id);
    return out;
  }

  forget(webContentsId: number): void {
    this.#roles.delete(webContentsId);
  }

  clear(): void {
    this.#roles.clear();
  }
}

/** Argument injected into the preload so it can pick its own behaviour. */
export function roleArgument(role: WindowRole): string {
  return `--wa-role=${role}`;
}

export function parseRoleArgument(args: readonly string[]): WindowRole | null {
  for (const arg of args) {
    if (arg === roleArgument('whatsapp')) return 'whatsapp';
    if (arg === roleArgument('settings')) return 'settings';
  }
  return null;
}
