// The list behind the bottom-left cards. See shared/issues.ts.
//
// No Electron in here, and nothing above it: the RPC client, the HTTP gate and the
// engine can all report a problem without knowing about windows. Kept for the life
// of the app, not written to disk: a condition that still holds is found again on
// the next launch, and the log keeps the rest.

import { maskSecrets, type AppIssue } from '../../shared/issues';

const MAX_ISSUES = 30;
const MAX_BODY = 600;

const issues = new Map<string, AppIssue>();
/** Conditions the user closed while they still held: shown again only once they
 *  have cleared and come back. Otherwise a socket retrying every 30 s reopens the
 *  card the moment it is closed, and the X does nothing. */
const closedWhileActive = new Set<string>();
let listener: ((list: AppIssue[]) => void) | null = null;

export function listIssues(): AppIssue[] {
  return [...issues.values()].sort((a, b) => b.firstAt - a.firstAt);
}

function changed(): void {
  listener?.(listIssues());
}

export function onIssuesChanged(fn: (list: AppIssue[]) => void): void {
  listener = fn;
}

export interface IssueReport {
  id: string;
  level: AppIssue['level'];
  title: string;
  body: string;
  /** Default true. False for a one-off, which reopens if it happens again. */
  condition?: boolean;
  action?: AppIssue['action'];
}

export function raiseIssue(r: IssueReport): void {
  const condition = r.condition ?? true;
  if (condition && closedWhileActive.has(r.id)) return;
  const title = maskSecrets(r.title);
  const body = maskSecrets(r.body).slice(0, MAX_BODY);
  const now = Date.now();
  const cur = issues.get(r.id);
  if (cur) {
    const same = cur.body === body && cur.title === title && cur.level === r.level && cur.clearedAt === null;
    cur.lastAt = now;
    // Still broken and saying the same thing: nothing to redraw. A condition is
    // reported every second by some callers, and its count would mean nothing.
    if (same && condition) return;
    if (!condition) cur.count += 1;
    cur.title = title;
    cur.body = body;
    cur.level = r.level;
    cur.clearedAt = null;
    changed();
    return;
  }
  issues.set(r.id, {
    id: r.id,
    level: r.level,
    title,
    body,
    firstAt: now,
    lastAt: now,
    count: 1,
    clearedAt: null,
    condition,
    action: r.action,
  });
  // An error storm must not grow without end. Whatever has already cleared goes
  // first, then the oldest; the log still has every one.
  while (issues.size > MAX_ISSUES) {
    const list = listIssues();
    const drop = [...list].reverse().find((i) => i.clearedAt !== null) ?? list[list.length - 1];
    issues.delete(drop.id);
  }
  changed();
}

/** The problem went away. The card stays and says so: the user asked for these to
 *  stay until closed, and a card vanishing by itself would leave them wondering. */
export function clearIssue(id: string): void {
  closedWhileActive.delete(id);
  const cur = issues.get(id);
  if (!cur || cur.clearedAt !== null) return;
  cur.clearedAt = Date.now();
  changed();
}

export function clearIssuesWithPrefix(prefix: string): void {
  for (const id of [...closedWhileActive]) if (id.startsWith(prefix)) closedWhileActive.delete(id);
  for (const id of [...issues.keys()]) if (id.startsWith(prefix)) clearIssue(id);
}

export function closeIssue(id: string): void {
  const cur = issues.get(id);
  if (!cur) return;
  if (cur.condition && cur.clearedAt === null) closedWhileActive.add(id);
  issues.delete(id);
  changed();
}

export function closeAllIssues(): void {
  for (const id of [...issues.keys()]) {
    const cur = issues.get(id);
    if (cur?.condition && cur.clearedAt === null) closedWhileActive.add(id);
    issues.delete(id);
  }
  changed();
}

/** For tests. */
export function resetIssues(): void {
  issues.clear();
  closedWhileActive.clear();
}
