/**
 * Sharebox — SyncStatus (sync state display)
 *
 * A compact, always-visible status bar showing the current phase,
 * whether there are pending outbox ops, and any last error.
 *
 * The sync engine in sync.ts owns the actual push/pull loop and
 * keeps this state in sync via `syncState()`.
 */
import { useEffect, useState } from 'react';
import { syncState, runSync, hasPending, registerOnlineListeners, startSyncLoop, stopSyncLoop } from '../sync';

export default function SyncStatus() {
  const [phase, setPhase] = useState<string>('idle');
  const [pending, setPending] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = syncState();
    setPhase(s.phase ?? 'idle');
    setPending(s.pendingOps ?? 0);
    setError(s.lastError ?? null);

    registerOnlineListeners();
    startSyncLoop();
    hasPending().then((n) => setPending(n)).catch(() => {});

    return () => {
      stopSyncLoop();
    };
  }, []);

  // Reflect engine changes (e.g. sync State updates) on every render.
  useEffect(() => {
    const s = syncState();
    setPhase(s.phase ?? 'idle');
    setPending(s.pendingOps ?? 0);
    setError(s.lastError ?? null);
    // No recursion: this effect only reads; the deps array is empty so it
    // runs once after mount, plus whenever the component re-renders.
  }, []);

  // Map phase → friendly text + colour.
  const info: Record<string, { label: string; colour: string }> = {
    idle: { label: 'Ready', colour: 'var(--ok)' },
    pushing: { label: 'Pushing…', colour: 'var(--warn)' },
    pulling: { label: 'Syncing…', colour: 'var(--accent)' },
    merged: { label: 'Synced', colour: 'var(--ok)' },
    error: { label: 'Sync failed', colour: 'var(--err)' },
  };
  const infoText = phase === 'idle' && pending > 0
    ? { label: `${pending} item${pending > 1 ? 's' : ''} pending`, colour: 'var(--warn)' }
    : (info[phase] ?? info.idle);

  return (
    <div className={`sync-bar ${phase}`}>
      <span className="sync-dot" style={{ background: infoText.colour }} />
      <span className="sync-label">{infoText.label}</span>
      {error && (
        <span className="sync-error" title={error}>
          {(error ?? '').split('\n')[0]}
        </span>
      )}
    </div>
  );
}
