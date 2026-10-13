/** JSON-lines logger on stdout. Keep panelist data out of logs beyond the name. */
type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  (level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => process.env.DEBUG && write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};

export function errorFields(err: unknown): Record<string, unknown> {
  return err instanceof Error ? { error: err.message } : { error: String(err) };
}
