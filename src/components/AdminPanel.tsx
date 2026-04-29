import React, { useState, useEffect, useRef, useCallback } from 'react';
import './AdminPanel.css';
import { subscribeLog, getLogBuffer, LogEntry, LogLevel } from '../utils/logger';

const LEVEL_COLORS: Record<LogLevel, string> = {
  log:      '#aaaaaa',
  info:     '#00ccff',
  warn:     '#ffcc00',
  error:    '#ff4444',
  'llm-req': '#ffaa00',
  'llm-res': '#aaff44',
  'llm-err': '#ff6644',
  audio:    '#cc88ff',
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  log:      'LOG',
  info:     'INF',
  warn:     'WRN',
  error:    'ERR',
  'llm-req': 'REQ',
  'llm-res': 'RES',
  'llm-err': 'LER',
  audio:    'AUD',
};

const ALL_LEVELS: LogLevel[] = ['log','info','warn','error','llm-req','llm-res','llm-err','audio'];

const AdminPanel: React.FC = () => {
  const [entries, setEntries] = useState<LogEntry[]>(() => getLogBuffer());
  const [filter, setFilter] = useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  pausedRef.current = paused;

  useEffect(() => {
    const unsub = subscribeLog(entry => {
      if (!pausedRef.current) {
        setEntries(prev => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    });
    return unsub;
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const toggleLevel = (level: LogLevel) => {
    setFilter(prev => {
      const next = new Set(prev);
      next.has(level) ? next.delete(level) : next.add(level);
      return next;
    });
  };

  const clearLogs = () => setEntries([]);

  const copyAll = () => {
    const text = entries
      .filter(e => filter.has(e.level))
      .map(e => `[${e.ts}] [${LEVEL_LABELS[e.level]}] ${e.message}`)
      .join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const visible = entries.filter(e =>
    filter.has(e.level) &&
    (search === '' || e.message.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="admin-panel">
      <div className="admin-toolbar">
        <div className="admin-filters">
          {ALL_LEVELS.map(level => (
            <button
              key={level}
              className={`admin-filter-btn ${filter.has(level) ? 'active' : ''}`}
              style={{ '--level-color': LEVEL_COLORS[level] } as React.CSSProperties}
              onClick={() => toggleLevel(level)}
            >
              {LEVEL_LABELS[level]}
            </button>
          ))}
        </div>
        <div className="admin-actions">
          <input
            className="admin-search"
            type="text"
            placeholder="FILTER..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            className={`admin-action-btn ${paused ? 'active' : ''}`}
            onClick={() => setPaused(v => !v)}
          >
            {paused ? '▶ RESUME' : '⏸ PAUSE'}
          </button>
          <button
            className={`admin-action-btn ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(v => !v)}
          >
            ↓ AUTO
          </button>
          <button className="admin-action-btn" onClick={copyAll}>⎘ COPY</button>
          <button className="admin-action-btn admin-clear" onClick={clearLogs}>✕ CLEAR</button>
        </div>
      </div>

      <div className="admin-count">
        {visible.length} / {entries.length} entries
        {paused && <span className="admin-paused-badge"> ⏸ PAUSED</span>}
      </div>

      <div className="admin-log-list" ref={listRef}>
        {visible.length === 0 && (
          <div className="admin-empty">NO LOG ENTRIES MATCH CURRENT FILTER</div>
        )}
        {visible.map(entry => (
          <div key={entry.id} className={`admin-entry admin-entry-${entry.level}`}>
            <span className="admin-entry-ts">{entry.ts}</span>
            <span
              className="admin-entry-level"
              style={{ color: LEVEL_COLORS[entry.level] }}
            >
              {LEVEL_LABELS[entry.level]}
            </span>
            <span className="admin-entry-msg">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AdminPanel;
