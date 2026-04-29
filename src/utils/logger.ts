// Global logger — intercepts console methods and stores entries for the admin panel

export type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'llm-req' | 'llm-res' | 'llm-err' | 'audio';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

type Listener = (entry: LogEntry) => void;

let counter = 0;
const listeners: Listener[] = [];
const buffer: LogEntry[] = [];
const MAX_BUFFER = 500;

const ts = () => {
  const n = new Date();
  return `${n.getHours().toString().padStart(2,'0')}:${n.getMinutes().toString().padStart(2,'0')}:${n.getSeconds().toString().padStart(2,'0')}.${n.getMilliseconds().toString().padStart(3,'0')}`;
};

export const pushLog = (level: LogLevel, message: string) => {
  const entry: LogEntry = { id: counter++, ts: ts(), level, message };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  listeners.forEach(fn => fn(entry));
};

export const subscribeLog = (fn: Listener) => {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i !== -1) listeners.splice(i, 1);
  };
};

export const getLogBuffer = () => [...buffer];

// Intercept native console methods
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
const _info  = console.info.bind(console);

const fmt = (...args: unknown[]) =>
  args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a))).join(' ');

console.log   = (...args) => { _log(...args);   pushLog('log',   fmt(...args)); };
console.warn  = (...args) => { _warn(...args);  pushLog('warn',  fmt(...args)); };
console.error = (...args) => { _error(...args); pushLog('error', fmt(...args)); };
console.info  = (...args) => { _info(...args);  pushLog('info',  fmt(...args)); };
