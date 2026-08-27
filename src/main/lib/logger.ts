/**
 * Structured logging.
 *
 * Why hand rolled instead of a dependency: the log line format is part of the
 * product (users paste these into bug reports, and the CI smoke test greps
 * them), it has to work identically in the packaged app and in `vitest`, and it
 * must never throw. It is ~150 lines and has zero transitive dependencies.
 *
 * Format: one JSON object per line (machine readable) in
 * `<userData>/logs/main.jsonl`, plus a human readable line on stderr while
 * attached to a terminal. journald/systemd users therefore get the pretty form
 * and support users get the JSON file.
 */

import { promises as fs } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export const LOG_LEVELS = ['silly', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  silly: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

export interface LogRecord {
  readonly ts: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly scope: string;
  readonly msg: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Keys whose values must never be written to disk. */
const REDACT_KEY =
  /(cookie|authorization|token|secret|password|apikey|api_key|phone|jid|ephemeral|lid|clienthello|keymaterial)/i;

const REDACTED = '[redacted]';

export interface LogWriter {
  write(record: LogRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface FileLogOptions {
  readonly filePath: string;
  /** Rotate when the active file exceeds this size. */
  readonly maxBytes?: number;
  /** How many rotated files to keep (`main.1.jsonl`, `main.2.jsonl`, ...). */
  readonly keep?: number;
}

/** JSON-lines file transport with size based rotation and back pressure free writes. */
export class FileLogWriter implements LogWriter {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  #dirReady = false;
  #bytesWritten = 0;
  #failed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FileLogOptions) {
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#keep = options.keep ?? 3;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Set to true once a write failed hard; the caller may then warn the user. */
  get degraded(): boolean {
    return this.#failed;
  }

  write(record: LogRecord): void {
    if (this.#failed) return;
    const line = `${JSON.stringify(record)}\n`;
    // Serialise all file work on a private promise chain: appendFile is
    // asynchronous and we must not interleave a rotation with a write.
    this.#queue = this.#queue.then(
      () => this.#writeLine(line),
      () => this.#writeLine(line),
    );
  }

  async #writeLine(line: string): Promise<void> {
    try {
      if (!this.#dirReady) {
        await mkdir(path.dirname(this.#filePath), { recursive: true });
        this.#dirReady = true;
        this.#bytesWritten = await this.#currentSize();
      }
      if (this.#bytesWritten + line.length > this.#maxBytes) await this.#rotate();
      await appendFile(this.#filePath, line, { encoding: 'utf8', mode: 0o600 });
      this.#bytesWritten += Buffer.byteLength(line, 'utf8');
    } catch (error: unknown) {
      // Logging must never take the application down, and never loop.
      this.#failed = true;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[logger] file transport disabled: ${reason}\n`);
    }
  }

  async #currentSize(): Promise<number> {
    try {
      const info = await stat(this.#filePath);
      return info.size;
    } catch {
      return 0;
    }
  }

  async #rotate(): Promise<void> {
    const dir = path.dirname(this.#filePath);
    const ext = path.extname(this.#filePath);
    const base = path.basename(this.#filePath, ext);
    // main.3 -> deleted, main.2 -> main.3, ... main.jsonl -> main.1.jsonl
    await fs.rm(path.join(dir, `${base}.${this.#keep}${ext}`), { force: true }).catch(() => undefined);
    for (let index = this.#keep - 1; index >= 1; index -= 1) {
      const from = path.join(dir, `${base}.${index}${ext}`);
      const to = path.join(dir, `${base}.${index + 1}${ext}`);
      await rename(from, to).catch(() => undefined);
    }
    await rename(this.#filePath, path.join(dir, `${base}.1${ext}`)).catch(() => undefined);
    this.#bytesWritten = 0;
  }

  async flush(): Promise<void> {
    await this.#queue.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

export interface LoggerOptions {
  readonly scope?: string;
  readonly level?: LogLevel;
  readonly writer?: LogWriter | null;
  /** Also print a human readable line on stderr. */
  readonly console?: boolean;
  readonly clock?: () => Date;
}

export class Logger {
  readonly #scope: string;
  readonly #level: LogLevel;
  readonly #writer: LogWriter | null;
  readonly #toConsole: boolean;
  readonly #clock: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#scope = options.scope ?? 'app';
    this.#level = options.level ?? 'info';
    this.#writer = options.writer ?? null;
    this.#toConsole = options.console ?? false;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Derive a logger with a `main.tray` style nested scope. */
  child(scope: string): Logger {
    return new Logger({
      scope: this.#scope === 'app' ? scope : `${this.#scope}.${scope}`,
      level: this.#level,
      writer: this.#writer,
      console: this.#toConsole,
      clock: this.#clock,
    });
  }

  get scope(): string {
    return this.#scope;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.#level] && this.#level !== 'silent';
  }

  log(level: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) return;
    const record: LogRecord = {
      ts: this.#clock().toISOString(),
      level,
      scope: this.#scope,
      msg,
      ...(data === undefined ? {} : { data: redact(data) }),
    };
    this.#writer?.write(record);
    if (this.#toConsole) {
      const suffix = record.data === undefined ? '' : ` ${inspect(record.data)}`;
      const line = `${record.ts} ${level.toUpperCase().padEnd(5)} [${record.scope}] ${msg}${suffix}\n`;
      process.stderr.write(line);
    }
  }

  silly(msg: string, data?: Record<string, unknown>): void {
    this.log('silly', msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  /** `log.error('failed', error)` serialises the error safely. */
  error(msg: string, error?: unknown, data?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { ...(data ?? {}) };
    if (error !== undefined) payload['error'] = serializeError(error);
    this.log('error', msg, Object.keys(payload).length > 0 ? payload : undefined);
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(cause === undefined ? {} : { cause: serializeError(cause) }),
    };
  }
  return { type: typeof error, value: String(error) };
}

function inspect(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '[unserialisable]';
  }
}

/** Recursively strip anything that smells like a credential or a phone number. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return '[truncated-depth]' as unknown as T;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value as readonly unknown[];
    return items.map((item: unknown) => redact<unknown>(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out as unknown as T;
  }
  if (typeof value === 'string') {
    // WhatsApp JIDs look like 4915123456789@s.whatsapp.net - never log them.
    return value.replace(/\b\d{8,16}(@s\.whatsapp\.net|@c\.us)\b/g, REDACTED) as unknown as T;
  }
  return value;
}

export interface CreateLoggerOptions {
  readonly logDir: string | null;
  readonly level?: LogLevel;
  readonly console?: boolean;
  readonly fileName?: string;
}

export interface LoggerBundle {
  readonly logger: Logger;
  readonly writer: FileLogWriter | null;
  readonly filePath: string | null;
}

export function createLogger(options: CreateLoggerOptions): LoggerBundle {
  const level = options.level ?? readLevelFromEnv() ?? (process.env['NODE_ENV'] === 'development' ? 'debug' : 'info');
  const toConsole = options.console ?? !process.env['ELECTRON_RUN_AS_NODE'];
  let writer: FileLogWriter | null = null;
  let filePath: string | null = null;
  if (options.logDir !== null) {
    filePath = path.join(options.logDir, options.fileName ?? 'main.jsonl');
    writer = new FileLogWriter({ filePath });
  }
  const logger = new Logger({ level, writer, console: toConsole });
  return { logger, writer, filePath };
}

function readLevelFromEnv(): LogLevel | null {
  const raw = process.env['WA_DESKTOP_LOG_LEVEL'];
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(lowered) ? (lowered as LogLevel) : null;
}

/** Test helper: collect records in memory. */
export class MemoryLogWriter implements LogWriter {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
  async flush(): Promise<void> {
    /* nothing to do */
  }
  async close(): Promise<void> {
    /* nothing to do */
  }
}
