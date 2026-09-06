// Animated numeric readout — spring-eased count toward the live value.
// Always animates — the readouts are part of the instrument. New animations
// start from the value currently on screen (not the last completed one), so
// rapid updates never snap the number backward.

import { useEffect, useRef, useState } from 'react';

export function NumberTicker({
  value,
  format,
  className,
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const raf = useRef(0);
  const displayRef = useRef(value);

  useEffect(() => {
    if (!Number.isFinite(displayRef.current)) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const startV = displayRef.current;
    const dur = 500;
    cancelAnimationFrame(raf.current);
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = startV + (value - startV) * eased;
      displayRef.current = v;
      setDisplay(v);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return <span className={className}>{format(display)}</span>;
}
