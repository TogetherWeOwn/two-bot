type Level = 'debug' | 'info' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, error: 2 };

let current: Level = 'info';
export function setLogLevel(l: Level) {
  current = l;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < order[current]) return;
  // One JSON object per line. Greppable, and ready for a log shipper later.
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
