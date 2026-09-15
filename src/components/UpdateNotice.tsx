// "There is a newer version" — the whole of the update story in the UI.
//
// It renders NOTHING in three of the four states. A user on the current
// build, a user ahead of it, and a user whose check could not reach krypt.cc
// all see an unchanged sidebar; only an actual newer version puts anything on
// screen. An update notice that is always visible is an advertisement.
//
// Clicking opens krypt.cc in the system browser. Nothing downloads here and
// nothing installs — see shared/version.ts for why this is a notice and not
// an updater.

import { useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import type { UpdateStatus } from '@shared/version';

const DOWNLOAD_URL = 'https://krypt.cc';

export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void window.krypt.update
        .status()
        .then((r) => {
          if (alive && r.ok && r.data) setStatus(r.data);
        })
        .catch(() => undefined);
    };
    read();
    // The check itself runs in main half a minute after boot, so the first
    // read here usually predates it. Asking again a few times costs nothing —
    // `status()` answers from memory and never touches the network.
    const t = setInterval(read, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (status?.state !== 'update') return null;

  return (
    <button
      onClick={() => window.krypt.app.openExternal(DOWNLOAD_URL)}
      title={status.detail}
      className={`group mb-2 flex w-full items-start gap-2 rounded-md border px-2 py-2 text-left transition ${
        status.important
          ? 'border-arc-gold/40 bg-arc-gold/10 hover:bg-arc-gold/15'
          : 'border-krypt-purple/40 bg-krypt-purple/10 hover:bg-krypt-purple/15'
      }`}
    >
      <ArrowUpCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${status.important ? 'text-arc-gold' : 'text-krypt-purple'}`} />
      <span className="min-w-0">
        <span className="block text-body font-semibold text-white/90">
          {status.important ? `Important update: ${status.latest}` : `Version ${status.latest} is out`}
        </span>
        <span className="block text-label leading-relaxed text-krypt-muted">
          You are on {status.current}. Get it from krypt.cc.
        </span>
      </span>
    </button>
  );
}
