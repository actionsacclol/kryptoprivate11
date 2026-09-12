// Is there a newer build than this one?
//
// The app has never asked. Every user who installed a version stayed on it
// until they happened to revisit krypt.cc, which for a desktop app that
// touches money and ships fixes weekly is the largest gap in the release.
//
// ─── What this is NOT ────────────────────────────────────────────────────
//
// Not an auto-updater. The main process is compiled to V8 bytecode behind
// Electron fuses and an integrity guard whose whole job is to refuse a
// modified build (crash-guard-policy: a launcher handles updates, never
// electron-updater). Something that rewrote the app in place would be
// fighting three layers built to stop exactly that. So this tells the user,
// with a link, and they decide. Nothing downloads, nothing installs, nothing
// on disk changes.
//
// ─── Unknown is a state, and it is the common one ────────────────────────
//
// krypt.cc is a static site with a catch-all: `GET /version.json` answers
// HTTP 200 with the site's HTML. Measured 2026-09-11. That is the polite
// refusal this codebase already has a name for (electron/data/refusals.ts) —
// a 200 that means no — and the reason `status` below has four values rather
// than a boolean.
//
// "We could not tell" must never render as "you are up to date". A user who
// is told they are current, by an app that never actually asked, is worse off
// than one who is told nothing: they stop checking.

/** A parsed semantic version. Pre-release and build metadata are ignored. */
/** major, minor, patch — and, when present, the pre-release tag. */
export type Version = [number, number, number] | [number, number, number, string];

/**
 * Parse `1.2.3`, `v1.2.3`, or `1.2.3-beta.7`, or return null.
 *
 * Deliberately strict about the numbers and relaxed about what follows them:
 * `package.json` versions in this repo have been `1.1.0`, `2.0.0` and
 * `1.0.0-beta.9`, and a checker that choked on the last one would go silent
 * on exactly the builds most likely to need updating.
 */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string') return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (!m) return null;
  // A pre-release tag rides along so 2.0.0-beta.7 can be told from 2.0.0:
  // until 2026-09-11 it was discarded, and a beta build read "up to date"
  // the day its final shipped. Found by audit.
  return m[4] ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a is older, 0 if equal, 1 if a is newer. A pre-release is older
 *  than its final (semver §11); two pre-releases compare identifier by identifier. */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) < (b[i] as number)) return -1;
    if ((a[i] as number) > (b[i] as number)) return 1;
  }
  const pa = a[3] as string | undefined;
  const pb = b[3] as string | undefined;
  if (pa === pb) return 0;
  if (pa === undefined) return 1; // a is the final, b the pre-release
  if (pb === undefined) return -1;
  // Dot-separated identifiers, numeric ones compared as numbers (semver
  // §11.4): beta.10 is after beta.9.
  const xs = pa.split('.');
  const ys = pb.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type UpdateState =
  /** A newer build is published. */
  | 'update'
  /** This build is the published one. */
  | 'current'
  /** This build is NEWER than what is published — a dev or pre-release tree. */
  | 'ahead'
  /** We could not find out. Never dressed up as either of the first two. */
  | 'unknown';

export interface UpdateStatus {
  state: UpdateState;
  /** This build. */
  current: string;
  /** What is published, when we managed to read it. */
  latest: string | null;
  /**
   * Said to the user, verbatim. Written here rather than in the component so
   * the four states cannot acquire a fifth phrasing in a UI file.
   */
  detail: string;
  /** When the last attempt happened, successful or not. Null = never. */
  checkedAt: number | null;
  /**
   * A build the publisher marked as important — a security or money-path fix.
   * Only ever true when `state` is 'update'; a flag on an unread answer is
   * not a flag.
   */
  important: boolean;
  /** Why the last attempt failed, when it did. Shown, not swallowed. */
  failure: string | null;
}

/** What a published version document is allowed to say. */
export interface VersionDoc {
  version: string;
  /** Optional: marks a release the publisher considers important. */
  important?: boolean;
  /** Optional: one line about the release. Never HTML, never a link. */
  note?: string;
}

/** The longest a `note` may be before it is dropped rather than shown. */
export const MAX_NOTE_LENGTH = 200;

/**
 * Read a fetched document into a `VersionDoc`, or refuse it.
 *
 * Everything about the shape is checked here, and the caller cannot skip it:
 * this is text from the network being rendered to a user, so it is validated
 * in shared code and pinned by a test, not trusted because it parsed.
 */
export function readVersionDoc(raw: unknown): VersionDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (parseVersion(o.version) === null) return null;
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  return {
    version: (o.version as string).trim(),
    important: o.important === true,
    // A note is a nicety. One that is too long, or carries markup, is
    // dropped rather than truncated into something that reads as ours.
    // …and one that carries a link is dropped too: a compromised host must
    // not be able to put "download from <url>" in our own voice.
    note: note && note.length <= MAX_NOTE_LENGTH && !/[<>]/.test(note) && !/https?:|:\/\/|www\./i.test(note) ? note : undefined,
  };
}

/**
 * Compare this build against what is published.
 *
 * `latestRaw` null means the check did not produce an answer — for any
 * reason, including a 200 that was not really an answer. That is `unknown`,
 * and it stays `unknown`.
 */
export function updateStatus(
  currentRaw: string,
  doc: VersionDoc | null,
  opts: { checkedAt: number | null; failure: string | null },
): UpdateStatus {
  const base = { current: currentRaw, latest: doc?.version ?? null, checkedAt: opts.checkedAt, failure: opts.failure };
  const cur = parseVersion(currentRaw);
  if (cur === null) {
    return { ...base, state: 'unknown', important: false, detail: `This build does not name a version we can compare (${currentRaw}).` };
  }
  if (!doc) {
    return {
      ...base,
      state: 'unknown',
      important: false,
      detail: opts.failure ? `Could not check for updates: ${opts.failure}` : 'Have not checked for updates yet.',
    };
  }
  const latest = parseVersion(doc.version)!;
  const cmp = compareVersions(cur, latest);
  if (cmp === 0) return { ...base, state: 'current', important: false, detail: `You are on the latest version (${currentRaw}).` };
  if (cmp > 0) {
    return { ...base, state: 'ahead', important: false, detail: `This build (${currentRaw}) is newer than the published ${doc.version}.` };
  }
  const head = doc.important
    ? `Version ${doc.version} is out, and it is marked important.`
    : `Version ${doc.version} is out. You are on ${currentRaw}.`;
  return { ...base, state: 'update', important: doc.important === true, detail: doc.note ? `${head} ${doc.note}` : head };
}
