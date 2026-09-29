import { useDebugMode } from '../../lib/debugMode';
import { IconAlert, IconCheck } from './Icons';

/** OK / Failed sensor status. Shown only in debug mode; production pages never show failures. */
export function StatusBadge({ ok, className = '' }: { ok: boolean; className?: string }) {
  const debug = useDebugMode();
  if (!debug) return null;
  return ok ? (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-xs font-semibold text-ok ${className}`}
    >
      <IconCheck size={14} strokeWidth={3} />
      OK
    </span>
  ) : (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-failed-soft px-2 py-0.5 text-xs font-semibold text-failed ${className}`}
    >
      <IconAlert size={14} strokeWidth={2.5} />
      Failed
    </span>
  );
}
