import { syncNow, useSyncState } from '../sync';

export default function SyncStatus() {
  const s = useSyncState();
  const label =
    s.status === 'syncing' ? 'Syncing…'
    : s.status === 'offline' ? (s.pending ? `Offline · ${s.pending} pending` : 'Offline')
    : s.status === 'error' ? 'Sync error'
    : s.pending ? `${s.pending} pending`
    : 'Synced';
  const title = s.error ?? (s.lastSyncedAt ? `Last synced ${new Date(s.lastSyncedAt).toLocaleTimeString()}` : 'Tap to sync');
  return (
    <button className={`sync sync-${s.status}`} onClick={() => void syncNow()} title={title}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-label">{label}</span>
    </button>
  );
}
