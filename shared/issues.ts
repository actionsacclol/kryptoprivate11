// Things that need the user, shown bottom left until they close them (2026-11-04).
//
// User report: a Helius key that was refused looked like "Scanning · paused" and
// the word "Attuning", with the reason only in a log file. So anything wrong with
// an API key, and any error the app used to flash and lose, is now a card with an
// X that stays until it is closed.
//
// Named "issues" because "alerts" already means the price alerts in shared/alerts.ts.

export interface AppIssue {
  id: string;
  level: 'error' | 'warn';
  /** May be empty: a one-off error has a sentence and nothing to title it with. */
  title: string;
  body: string;
  firstAt: number;
  lastAt: number;
  /** How many times the same thing has happened. */
  count: number;
  /** When the problem went away. The card stays until closed and says so. */
  clearedAt: number | null;
  /** A condition is one problem however often it is reported, so closing it holds
   *  until it clears. A one-off comes back if it happens again. */
  condition: boolean;
  /** A place in the app that fixes this. */
  action?: { label: string; route: 'settings' };
}

/** Provider text and socket errors can repeat the URL they were given, and a
 *  keyed URL carries the key. Nothing leaves this file with one in it. */
export function maskSecrets(text: string): string {
  return String(text ?? '')
    .replace(/([?&](?:api[-_]?key|token|key|auth)=)[^&\s"'<>]+/gi, '$1***')
    .replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, '$1***');
}

/** What one reply from Helius was. `null` means no reply, which says nothing
 *  about the key: a dropped connection must not raise or clear anything. */
export interface HeliusAnswer {
  /** 101 for a socket that opened. */
  status: number;
  body: string;
}

export interface HeliusVerdict {
  /** Helius says the plan is out of credits, on the socket. */
  socketSpent: boolean;
  /** The same on ordinary requests, which can still work when the socket does not. */
  httpSpent: boolean;
  /** The key itself was turned down. */
  refused: 401 | 403 | null;
  /** The socket was refused for some other reason: what Helius said. */
  limited: string | null;
  /** The socket opened and nothing was wrong with ordinary requests. */
  fine: boolean;
}

// Helius FAQ: "Requests return a 429 max usage reached error once your credits
// are exhausted." Seen on a websocket handshake 2026-11-04, with getSlot still
// answering 200 on the same key.
const isSpent = (a: HeliusAnswer | null): boolean => !!a && a.status === 429 && /max usage/i.test(a.body);
const isRefused = (a: HeliusAnswer | null): 401 | 403 | null => {
  if (!a || (a.status !== 401 && a.status !== 403)) return null;
  // A challenge page in front of the host is not a verdict on the key.
  return /^\s*</.test(a.body) ? null : (a.status as 401 | 403);
};

export function classifyHelius(http: HeliusAnswer | null, socket: HeliusAnswer | null): HeliusVerdict {
  const socketSpent = isSpent(socket);
  const httpSpent = isSpent(http);
  const refused = isRefused(http) ?? isRefused(socket);
  const limited = socket && socket.status === 429 && !socketSpent ? socket.body.trim() || 'HTTP 429' : null;
  const httpFine = !http || (http.status >= 200 && http.status < 300);
  return { socketSpent, httpSpent, refused, limited, fine: !!socket && socket.status === 101 && httpFine };
}
