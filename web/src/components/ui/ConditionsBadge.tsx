import type { Sample } from '@sylvan/shared';
import { evaluateConditions, useConditionAverages, type Rating } from '../../lib/conditions';
import { displayReadings } from '../../lib/readings';

const TEXT: Record<Rating, { label: string; className: string }> = {
  good: { label: 'Good for trees', className: 'bg-ok-soft text-ok' },
  fair: { label: 'Fair for trees', className: 'bg-warn-soft text-ink' },
  poor: { label: 'Poor for trees', className: 'bg-failed-soft text-failed' },
};

/** Weather verdict: the sample's readings against the current averages. */
export function ConditionsBadge({
  sample,
  className = '',
}: {
  sample: Pick<Sample, 'ok' | 'temperature' | 'humidity' | 'lux' | 'fallback'>;
  className?: string;
}) {
  const averages = useConditionAverages();
  const readings = displayReadings(sample);
  if (!readings || !averages) return null;
  const { label, className: tone } = TEXT[evaluateConditions(readings, averages).verdict];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone} ${className}`}
    >
      {label}
    </span>
  );
}
