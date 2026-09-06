import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cls } from '../utils/format';

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-7 pb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-[0.06em] text-white">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-krypt-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="flex-1 overflow-auto px-8 pb-8">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      {(title || actions) && (
        <div className="flex items-end justify-between gap-4 mb-3">
          <div className="min-w-0 flex-1">
            {title && (
              <div className="flex items-center gap-3">
                <h2 className="font-display text-[11px] font-semibold uppercase tracking-[0.3em] text-krypt-muted whitespace-nowrap">
                  {title}
                </h2>
                <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" aria-hidden="true" />
              </div>
            )}
            {description && <p className="text-xs text-krypt-muted/80 mt-1">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({
  className,
  children,
  hoverable,
  padded = true,
}: {
  className?: string;
  children: ReactNode;
  hoverable?: boolean;
  padded?: boolean;
}) {
  return (
    <div
      className={cls(
        'plate rounded-lg backdrop-blur-sm',
        padded && 'p-5',
        hoverable && 'transition hover:!border-white/20 hover:shadow-krypt-glow',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
  className,
  type = 'button',
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'inline-flex items-center justify-center gap-2 rounded-lg border border-krypt-purple/50 px-4 py-2.5 text-sm font-semibold text-white shadow-krypt-glow bg-krypt-gradient transition',
        'hover:brightness-110 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:brightness-75',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  children,
  className,
  destructive,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition',
        destructive
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
          : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10 hover:border-white/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  onClick,
  title,
  children,
  active,
  destructive,
  disabled,
}: {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cls(
        'h-9 w-9 rounded-lg border flex items-center justify-center transition',
        active
          ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white shadow-krypt-glow'
          : destructive
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100'
            : 'border-white/10 bg-white/5 text-krypt-muted hover:bg-white/10 hover:text-white hover:border-white/20',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cls(
        'flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3 cursor-pointer transition',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5 hover:border-white/20',
      )}
    >
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        {description && <div className="text-xs text-krypt-muted mt-1">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        className={cls(
          'relative h-6 w-11 rounded-full transition flex-shrink-0 mt-0.5',
          checked
            ? 'bg-krypt-gradient shadow-[0_0_10px_rgba(139,124,232,0.5)]'
            : 'bg-white/10',
        )}
      >
        <span
          className={cls(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

/**
 * Numeric input with a local editing buffer. Why not bind straight to the
 * number? A controlled `value={n}` that clamps on every keystroke makes the
 * field impossible to clear — deleting all digits parses to 0 and snaps to
 * `min`, so you can never type a fresh value (you'd be stuck nudging arrows).
 * Instead we keep a string buffer while focused (clear/partial input is fine),
 * emit the parsed number live (parent may clamp for storage), and only clamp
 * the field itself to [min,max] on blur. Re-syncs from the prop when not
 * focused, so external changes (reset, arrows) still reflect.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  suffix,
  className,
  warn,
}: {
  value: number;
  onChange: (next: number) => void;
  /** Advisory only — a value below this WARNS, it does not clamp. */
  min?: number;
  /** Advisory only — a value above this WARNS, it does not clamp. */
  max?: number;
  suffix?: string;
  className?: string;
  /** Custom warning for the current value; null = fine. Overrides min/max. */
  warn?: (n: number) => string | null;
  /** Accepted for backward compatibility; ignored now that this is a text
   *  field with no spinner. */
  step?: number;
}) {
  const fmt = (v: number): string => (Number.isFinite(v) ? String(v) : '');
  const [text, setText] = useState<string>(() => fmt(value));
  const focused = useRef(false);

  // Reflect external value changes only while the user isn't actively editing,
  // so a live parent update can't yank characters out from under them.
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);

  // No clamping — the user's number is accepted as typed. Commit on blur/Enter
  // so intermediate states ("0.", "1e") never fight the keystrokes, and never
  // write a half-typed value to the setting.
  const commit = (): void => {
    focused.current = false;
    const raw = text.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      setText(fmt(value)); // genuinely not a number — revert to the last good one
      return;
    }
    setText(fmt(n));
    if (n !== value) onChange(n);
  };

  // Live warning, shown but never blocking.
  const n = Number(text.trim());
  const warning =
    text.trim() === '' || !Number.isFinite(n)
      ? null
      : warn
        ? warn(n)
        : typeof min === 'number' && n < min
          ? `Below ${min}${suffix ? ' ' + suffix : ''}`
          : typeof max === 'number' && n > max
            ? `Above ${max}${suffix ? ' ' + suffix : ''}`
            : null;

  return (
    // The wrapper carries the caller's width; the control FILLS it. It used
    // to be an inline-flex sized by its own contents, so a caller asking for
    // w-28 got a ~150px control that spilled over whatever sat next to it
    // (seen on the Runners header, where it covered the refresh button).
    <div className={cls('min-w-0', className)}>
      <div className="flex w-full items-center rounded-lg border border-white/10 bg-black/40 overflow-hidden">
        {/* type="text" + inputMode="decimal": no spinner, no browser range
            rejection — just a text field that happens to hold a number. */}
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onFocus={() => { focused.current = true; }}
          onBlur={commit}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none"
        />
        {suffix && <div className="flex-shrink-0 pr-2 text-xs uppercase text-krypt-muted">{suffix}</div>}
      </div>
      {warning && <div className="mt-0.5 text-[10px] text-arc-gold/90">{warning}</div>}
    </div>
  );
}

export function Empty({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 rounded-lg border border-dashed border-white/10 bg-black/20">
      <svg viewBox="0 0 48 48" className="h-10 w-10 mb-4 text-krypt-purple/45 animate-rune-pulse" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="24" cy="24" r="20" />
        <circle cx="24" cy="24" r="12" strokeDasharray="2 4" />
        <path d="M24 4v8M24 36v8M4 24h8M36 24h8" />
        <circle cx="24" cy="24" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <div className="font-display text-sm font-semibold tracking-[0.12em] text-white">{title}</div>
      {message && <div className="text-sm text-krypt-muted mt-2 max-w-md">{message}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'gradient';
}) {
  const styles: Record<string, string> = {
    neutral: 'border-white/10 bg-white/5 text-krypt-muted',
    success: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
    warn:    'border-amber-400/30 bg-amber-500/10 text-amber-300',
    danger:  'border-rose-400/30 bg-rose-500/10 text-rose-300',
    gradient:'border-krypt-purple/40 bg-krypt-purple/10 text-krypt-pink',
  };
  return (
    <span className={cls('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', styles[tone])}>
      {children}
    </span>
  );
}
