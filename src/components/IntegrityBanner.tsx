import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

// Shown only on a build whose runtime self-checks have failed for long enough
// to stop it opening positions (electron/system/integrityGuard.ts).
//
// On a genuine build this component renders nothing, ever — the check behind
// it is a pure function of the app's own embedded constants, so it is false on
// every machine, forever. It is mounted unconditionally anyway: a banner that
// only mounts under a condition is a banner a cracker can delete by deleting
// one line in App.tsx, and the buy path refuses on its own regardless.
//
// The wording is deliberately plain. Someone reading this may have bought a
// "cracked" copy without knowing what that meant, so it says what happened,
// what still works — everything to do with getting money OUT — and how to get
// a working build.

export function IntegrityBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const r = await window.krypt.app.integrity();
      if (alive && r.ok) setMessage(r.data?.seized ? r.data.message : null);
    };
    void check();
    const t = setInterval(() => void check(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!message) return null;

  return (
    <div className="flex items-start gap-2 border-b border-rose-500/40 bg-rose-500/15 px-4 py-2">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
      <div className="text-[11px] leading-relaxed text-rose-100">{message}</div>
    </div>
  );
}
