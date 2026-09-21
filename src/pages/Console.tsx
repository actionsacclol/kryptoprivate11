// The Console — the living record of everything the engine does. Plain
// monospace lines stay perfectly readable; important events earn a small
// rune stamp in the margin. Filterable by severity, searchable, and it only
// follows the tail while you are already at the bottom.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, Empty, Page, Section } from '../components/common';
import { cls, fmtClock } from '../utils/format';
import type { EngineEvent } from '@shared/types';

interface Line {
  /** Stable per-session id so list keys survive the sliding window. */
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  line: string;
}

const CAP = 500;
let seq = 0;

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

/** Rune stamp for notable events, detected from the line itself. */
function stampFor(l: Line): { glyph: string; cls: string; label: string } | null {
  const t = l.line.toLowerCase();
  if (t.includes('kill switch')) return { glyph: '⨂', cls: 'text-rose-400', label: 'kill switch' };
  if (l.level === 'error') return { glyph: '✕', cls: 'text-rose-400', label: 'error' };
  if (t.includes('enter') && !t.includes('entries')) return { glyph: '✦', cls: 'text-arc-gold', label: 'entered' };
  if (t.includes('sold') || t.includes('sell') || t.includes('exit')) return { glyph: '◆', cls: 'text-emerald-300', label: 'sold' };
  if (t.includes('reject')) return { glyph: '⊘', cls: 'text-rose-300/80', label: 'rejected' };
  if (t.includes('detect') || t.includes('launch')) return { glyph: '·', cls: 'text-krypt-pink', label: 'detected' };
  return null;
}

export function Console() {
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    void window.krypt.log.recent().then((r) => {
      if (alive && r.ok && r.data) {
        // The history goes FIRST and the live lines that beat it here go
        // after; a live line arriving first used to make the 500-line
        // history give way to itself. Found by audit 2026-09-11.
        setLines((cur) => {
          const history = r.data!.map((l) => ({ ...l, id: seq++ }));
          const merged = [...history, ...cur];
          return merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
        });
      }
    });
    const off = window.krypt.engine.onEvent((ev: EngineEvent) => {
      if (ev.kind !== 'log') return;
      setLines((cur) => {
        const next = [...cur, { id: seq++, at: ev.at, level: ev.level, line: ev.line }];
        return next.length > CAP ? next.slice(next.length - CAP) : next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Follow the tail only while the reader is already there. Keyed on the
  // array itself — at the CAP the length stops changing but content doesn't.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (level !== 'all' && l.level !== level) return false;
      if (q && !l.line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, level, query]);

  const counts = useMemo(() => ({
    warn: lines.filter((l) => l.level === 'warn').length,
    error: lines.filter((l) => l.level === 'error').length,
  }), [lines]);

  return (
    <Page
      title="Console"
      subtitle="The engine's living record — feed state, decisions, warnings."
      actions={
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-white/10 bg-black/30 overflow-hidden">
            {(['all', 'info', 'warn', 'error'] as LevelFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setLevel(f)}
                className={cls(
                  'px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition',
                  level === f
                    ? f === 'error' ? 'bg-rose-500/20 text-rose-200'
                    : f === 'warn' ? 'bg-amber-500/20 text-amber-200'
                    : 'bg-krypt-purple/20 text-white'
                    : 'text-krypt-muted hover:text-white',
                )}
              >
                {f}
                {f === 'warn' && counts.warn > 0 && <span className="ml-1 font-mono">{counts.warn}</span>}
                {f === 'error' && counts.error > 0 && <span className="ml-1 font-mono">{counts.error}</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-krypt-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the record…"
              className="w-44 bg-transparent text-xs text-white outline-none placeholder:text-krypt-muted/60"
            />
          </div>
        </div>
      }
    >
      <Section>
        {lines.length === 0 ? (
          <Empty title="The record is blank" message="Start the engine to begin the entry." />
        ) : (
          <Card padded={false} className="font-mono text-xs">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="max-h-[calc(100vh-260px)] overflow-auto px-4 py-3 space-y-0.5"
            >
              {visible.length === 0 ? (
                <div className="py-8 text-center text-krypt-muted/70">Nothing matches the current filter.</div>
              ) : (
                visible.map((l) => {
                  const stamp = stampFor(l);
                  return (
                    <div key={l.id} className="flex gap-2.5 leading-relaxed">
                      <span className="w-3 flex-shrink-0 text-center" title={stamp?.label}>
                        {stamp && <span className={stamp.cls}>{stamp.glyph}</span>}
                      </span>
                      <span className="text-krypt-muted/60 flex-shrink-0">{fmtClock(l.at)}</span>
                      <span
                        className={cls(
                          'break-all',
                          l.level === 'error' && 'text-rose-300',
                          l.level === 'warn' && 'text-amber-300',
                          l.level === 'info' && 'text-white/85',
                        )}
                      >
                        {l.line}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        )}
      </Section>
    </Page>
  );
}
