// Bottom left: API key problems and errors, each with an X, there until closed.
// The list lives in main (electron/system/appIssues.ts); see shared/issues.ts.
//
// Its own leaf with its own subscription, so a new card redraws these cards and not
// the app. Plain panels rather than liquid glass: these can stay on screen for hours,
// and the glass lens costs about 5 ms per surface per frame.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, XCircle, X } from 'lucide-react';
import type { AppIssue } from '@shared/issues';
import { cls } from '../utils/format';

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function IssueCard({
  issue,
  onClose,
  onOpen,
}: {
  issue: AppIssue;
  onClose: () => void;
  onOpen: (route: 'settings') => void;
}) {
  const cleared = issue.clearedAt !== null;
  const Icon = cleared ? CheckCircle2 : issue.level === 'error' ? XCircle : AlertTriangle;
  return (
    <div
      role={issue.level === 'error' && !cleared ? 'alert' : 'status'}
      data-issue={issue.id}
      className={cls(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-krypt-panel p-3 shadow-lg',
        cleared ? 'border-white/10' : issue.level === 'error' ? 'border-red-500/50' : 'border-amber-500/50',
      )}
    >
      <Icon
        className={cls(
          'mt-0.5 h-4 w-4 flex-shrink-0',
          cleared ? 'text-emerald-400' : issue.level === 'error' ? 'text-red-400' : 'text-amber-400',
        )}
      />
      <div className="min-w-0 flex-1 select-text">
        {issue.title && <div className="text-sm font-medium text-white">{issue.title}</div>}
        <div className="mt-0.5 break-words text-xs leading-relaxed text-white/70">{issue.body}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/40">
          <span>{clock(issue.firstAt)}</span>
          {issue.count > 1 && <span>{issue.count} times</span>}
          {cleared && <span className="text-emerald-400">Cleared {clock(issue.clearedAt as number)}</span>}
          {issue.action && !cleared && (
            <button
              type="button"
              className="text-krypt-purple hover:underline"
              onClick={() => onOpen(issue.action!.route)}
            >
              {issue.action.label}
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className="flex-shrink-0 rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function IssueStack({
  besideSidebar,
  onOpen,
}: {
  besideSidebar: boolean;
  onOpen: (route: 'settings') => void;
}) {
  const [issues, setIssues] = useState<AppIssue[]>([]);

  useEffect(() => {
    let pushed = false;
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'issues') return;
      pushed = true;
      setIssues(ev.issues);
    });
    void window.krypt.issues
      .list()
      .then((r) => {
        // A push that beat this reply is newer than it.
        if (!pushed && r.ok && r.data) setIssues(r.data);
      })
      .catch(() => undefined);
    return off;
  }, []);

  if (issues.length === 0) return null;

  const close = (id: string): void => {
    setIssues((list) => list.filter((i) => i.id !== id));
    void window.krypt.issues.close(id).catch(() => undefined);
  };

  // Under the wallet panel and the confirm dialogs, over the pages. Beside the
  // sidebar rather than on it: the status row and the navigation stay readable.
  return createPortal(
    <div
      data-issue-stack
      className={cls(
        'pointer-events-none fixed bottom-3 z-[850] flex max-h-[70vh] w-[340px] max-w-[calc(100vw-1.5rem)] flex-col gap-2 overflow-y-auto',
        besideSidebar ? 'left-[218px]' : 'left-3',
      )}
    >
      {issues.length >= 3 && (
        <button
          type="button"
          className="pointer-events-auto self-end rounded border border-white/10 bg-krypt-panel px-2 py-0.5 text-[11px] text-white/60 hover:text-white"
          onClick={() => {
            setIssues([]);
            void window.krypt.issues.closeAll().catch(() => undefined);
          }}
        >
          Close all
        </button>
      )}
      {issues.map((i) => (
        <IssueCard key={i.id} issue={i} onClose={() => close(i.id)} onOpen={onOpen} />
      ))}
    </div>,
    document.body,
  );
}
