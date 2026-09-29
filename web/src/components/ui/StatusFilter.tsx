import type { SampleStatusFilter } from '@sylvan/shared';
import { useDebugMode } from '../../lib/debugMode';

const OPTIONS: { value: SampleStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ok', label: 'OK' },
  { value: 'failed', label: 'Failed' },
];

export function StatusFilter({
  value,
  onChange,
}: {
  value: SampleStatusFilter;
  onChange: (value: SampleStatusFilter) => void;
}) {
  // Filtering by failed samples is a debugging tool; production shows every sample alike.
  const debug = useDebugMode();
  if (!debug) return null;
  return (
    <div
      role="group"
      aria-label="Status"
      className="inline-flex rounded-md border border-border bg-surface-muted p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              onChange(option.value);
            }}
            className={`min-h-10 rounded-sm px-4 text-sm font-medium transition-colors ${
              active ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
