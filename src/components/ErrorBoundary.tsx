import { Component, type ErrorInfo, type ReactNode } from 'react';

// Last line of defence for the renderer (2026-08-28).
//
// Without a boundary, one thrown render — a provider returning an
// unexpected shape into a `.map`, say — unmounts the React root. The user
// then sees the void background with no controls while the engine keeps
// running with real positions and no kill switch on screen. This panel
// keeps two things reachable no matter what: reload the UI, and stop the
// engine. It deliberately uses no app state, hooks or providers, so it
// cannot itself be taken down by whatever broke the tree.

interface State {
  error: Error | null;
  stopping: boolean;
  stopped: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stopping: false, stopped: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    // One string, stack included — see main.tsx for why.
    console.error(`[ui] render crashed ${error.stack ?? error.message}
component stack:${info.componentStack ?? ' (none)'}`);
  }

  private stopEngine = async (): Promise<void> => {
    this.setState({ stopping: true });
    try {
      const r = await window.krypt.engine.kill();
      // Report what the engine says it did, not a fixed sentence — the two
      // disagreed, and this panel is shown exactly when the user cannot
      // check for themselves.
      this.setState({ stopped: r.ok ? r.message : `Stop failed: ${r.message}` });
    } catch (e) {
      this.setState({ stopped: `Stop failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.setState({ stopping: false });
    }
  };

  render(): ReactNode {
    const { error, stopping, stopped } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-krypt-void p-6">
        <div className="w-full max-w-lg rounded-2xl border border-rose-500/30 bg-krypt-panel p-6 shadow-krypt-card">
          <div className="font-display text-body tracking-eyebrow text-rose-300/80">RENDERER CRASHED</div>
          <h2 className="mt-1 text-lg font-semibold text-white">The interface hit an error</h2>
          <p className="mt-3 text-sm text-krypt-muted leading-relaxed">
            The trading engine is unaffected and still running in the background. Reload the
            interface to continue, or stop the engine first if you would rather nothing trades
            while you are blind.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-body leading-snug text-rose-200/90 whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>
          {stopped && <div className="mt-3 text-xs text-krypt-muted">{stopped}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={this.stopEngine}
              disabled={stopping || stopped !== null}
              className="rounded-lg border border-rose-500/60 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30 transition disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop engine'}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow hover:brightness-110 transition"
            >
              Reload interface
            </button>
          </div>
        </div>
      </div>
    );
  }
}
