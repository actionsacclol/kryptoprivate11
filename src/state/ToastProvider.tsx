import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { isPanelWindow } from '../panels/windowId';
import { cls } from '../utils/format';

type Level = 'info' | 'success' | 'warn' | 'error';

interface ToastEntry {
  id: number;
  level: Level;
  message: string;
}

interface ToastApi {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const COLORS: Record<Level, { ring: string; icon: typeof CheckCircle2; tint: string }> = {
  info:    { ring: 'border-indigo-400/40 bg-indigo-500/10',  icon: Info,         tint: 'text-indigo-300' },
  success: { ring: 'border-emerald-400/40 bg-emerald-500/10', icon: CheckCircle2, tint: 'text-emerald-300' },
  warn:    { ring: 'border-amber-400/40 bg-amber-500/10',    icon: AlertTriangle,tint: 'text-amber-300' },
  error:   { ring: 'border-rose-400/40 bg-rose-500/10',      icon: XCircle,      tint: 'text-rose-300' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // Constant for the life of the window: the hash names the panel at load.
  const panelWindow = isPanelWindow();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (level: Level, message: string) => {
      const id = ++idRef.current;
      setToasts((cur) => [...cur, { id, level, message }]);
      window.setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      info: (m) => push('info', m),
      success: (m) => push('success', m),
      warn: (m) => push('warn', m),
      error: (m) => push('error', m),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Below the top bar, not over it. At `top-4` a toast landed on the
          balance and the wallet — the two things someone is most likely to be
          reading when one arrives. The bar is ~49 px (px-5 py-2.5 plus a
          border), so this clears it with room to spare.

          A popped-out panel gets none of this: engine toasts are about the app
          as a whole and belong in the window that IS the app, and a 360 px
          card inside a 420 px panel window covers the panel it was popped out
          to show. */}
      <div
        className={cls(
          'pointer-events-none fixed right-4 top-16 z-[1000] flex flex-col gap-2 w-[360px]',
          panelWindow && 'hidden',
        )}
      >
        {toasts.map((t) => {
          const c = COLORS[t.level];
          const Icon = c.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto animate-pop-in flex items-start gap-3 rounded-xl border ${c.ring} px-3 py-2.5 backdrop-blur-md shadow-krypt-card`}
            >
              <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${c.tint}`} />
              <div className="flex-1 text-sm text-white/95 leading-snug">{t.message}</div>
              <button
                onClick={() => remove(t.id)}
                className="text-krypt-muted hover:text-white transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
