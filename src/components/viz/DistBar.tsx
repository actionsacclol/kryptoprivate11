// Horizontal share bar for a categorical breakdown (exit reasons, decision
// mix). One row per category, direct-labeled, purple-tinted by share.

import { motion } from 'framer-motion';

export function DistBar({
  items,
}: {
  items: Array<{ label: string; value: number; tone?: 'good' | 'bad' | 'neutral' }>;
}) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const color = (tone?: string): string =>
    tone === 'good' ? '#22C55E' : tone === 'bad' ? '#EF4444' : '#8B7CE8';
  return (
    <div className="space-y-2">
      {sorted.map((it) => {
        const pct = (it.value / total) * 100;
        return (
          <div key={it.label} className="flex items-center gap-3">
            <div className="w-32 text-xs text-krypt-muted capitalize truncate">{it.label.replace(/_/g, ' ')}</div>
            <div className="flex-1 h-5 rounded-md bg-black/30 overflow-hidden">
              <motion.div
                className="h-full rounded-md flex items-center justify-end pr-2"
                style={{ backgroundColor: color(it.tone), opacity: 0.35 + 0.5 * (pct / 100) }}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(pct, 6)}%` }}
                transition={{ duration: 0.4 }}
              >
                <span className="text-label font-mono text-white/90">{it.value}</span>
              </motion.div>
            </div>
            <div className="w-10 text-right text-body font-mono text-krypt-muted">{pct.toFixed(0)}%</div>
          </div>
        );
      })}
    </div>
  );
}
