import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

// Shown only when an RPC endpoint is actively refusing our key.
//
// A user reported "RPC HTTP 401" over and over on 2026-09-05. The app now
// fails over to the public endpoint so it keeps working, but a silent
// failover is its own kind of confusing — the paid key is doing nothing and
// nothing says so. This line appears directly under the key field, which is
// the only place the problem can actually be fixed.

type Rejected = { host: string; code: '401' | '403'; message: string } | null;

export function RpcKeyWarning() {
  const [rejected, setRejected] = useState<Rejected>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const r = await window.krypt.rpc.health();
      if (alive && r.ok) setRejected(r.data?.rejected ?? null);
    };
    void check();
    const t = setInterval(() => void check(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!rejected) return null;

  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
      <div>
        <div className="text-[11px] font-semibold text-rose-200">
          {rejected.host} is rejecting this key (HTTP {rejected.code})
        </div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-krypt-muted">
          Trading and reads have moved to the public endpoint, so the app still works. Speed-sensitive features
          are limited until the key is fixed. Paste a working key above and save, or clear the field to run on
          public endpoints on purpose.
        </div>
      </div>
    </div>
  );
}
