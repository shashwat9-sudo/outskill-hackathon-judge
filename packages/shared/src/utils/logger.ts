/**
 * Structured logging with mandatory redaction.
 *
 * Every record passes through the redactor before it is emitted. This is not a
 * convention that call sites are asked to follow — a caller cannot log a
 * credential even by accident, because the redaction happens inside `emit`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are replaced wholesale, matched case-insensitively on a
 * substring so `demoPassword`, `password_ciphertext` and `apiKey` all hit.
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'cookie',
  'session',
  'privatekey',
  'private_key',
  'encryptionkey',
  'ciphertext',
  'email',
  'phone',
];

/** Value-level patterns, for secrets that arrive inside a free-text string. */
const VALUE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[email redacted]' },
  { pattern: /\b(?:\+?\d[\d\s\-().]{7,}\d)\b/g, replacement: '[phone redacted]' },
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replacement: '[token redacted]' },
];

export const REDACTED = '[redacted]';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max depth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const { pattern, replacement } of VALUE_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, depth + 1) };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  sink?: (record: LogRecord) => void;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly name: string;
  private readonly sink: (record: LogRecord) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.name = options.name ?? 'app';
    this.sink =
      options.sink ??
      ((record) => {
        const line = JSON.stringify(record);
        if (record.level === 'error') process.stderr.write(`${line}\n`);
        else process.stdout.write(`${line}\n`);
      });
  }

  child(name: string): Logger {
    return new Logger({ level: this.level, name: `${this.name}:${name}`, sink: this.sink });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.emit('error', message, context);
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    this.sink({
      level,
      message: redactValue(message) as string,
      timestamp: new Date().toISOString(),
      context: context ? (redactValue({ logger: this.name, ...context }) as Record<string, unknown>) : { logger: this.name },
    });
  }
}

export const logger = new Logger({ name: 'ohj' });
