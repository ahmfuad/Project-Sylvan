import type { Sample } from '@sylvan/shared';
import { METRICS, METRIC_KEYS, type MetricKey } from '../../lib/constants';
import { useDebugMode } from '../../lib/debugMode';
import { formatReading } from '../../lib/format';
import { displayReadings } from '../../lib/readings';
import { IconDroplet, IconLight, IconThermometer } from './Icons';

export const METRIC_ICONS: Record<MetricKey, typeof IconThermometer> = {
  temperature: IconThermometer,
  humidity: IconDroplet,
  lux: IconLight,
};

type ReadingValues = Pick<Sample, 'ok' | 'temperature' | 'humidity' | 'lux' | 'fallback'>;

/** Debug-mode marker for values that are fallback averages, not measurements. */
function EstimatedNote({ className = '' }: { className?: string }) {
  return <span className={`text-xs text-failed ${className}`}>estimated (sensor failed)</span>;
}

/** Compact one-line readings for cards: "24.5 °C · 61.0 % · 820 lx". */
export function CompactReadings({
  sample,
  className = '',
}: {
  sample: ReadingValues;
  className?: string;
}) {
  const debug = useDebugMode();
  const values = displayReadings(sample);
  if (!values) return <p className={`text-xs text-ink-muted ${className}`}>—</p>;
  return (
    <dl className={`flex flex-wrap gap-x-3 gap-y-1 text-xs tabular ${className}`}>
      {METRIC_KEYS.map((key) => {
        const Icon = METRIC_ICONS[key];
        return (
          <div key={key} className="flex items-center gap-1">
            <dt>
              <Icon size={14} className={METRICS[key].textClass} />
              <span className="sr-only">{METRICS[key].label}</span>
            </dt>
            <dd className="text-ink">{formatReading(key, values[key])}</dd>
          </div>
        );
      })}
      {debug && values.estimated && <EstimatedNote />}
    </dl>
  );
}

/** Large readings with labels, used by the latest sample, lightbox and detail page. */
const LIST_LAYOUTS = {
  /** Always one tile per row. */
  stack: 'grid-cols-1',
  /** Three tiles side by side once there is room. */
  row: 'grid-cols-1 min-[400px]:grid-cols-3',
  /** Side by side on phones, stacked in a narrow sidebar on wider screens. */
  sidebar: 'grid-cols-1 min-[400px]:grid-cols-3 md:grid-cols-1',
};

export function ReadingList({
  sample,
  notes,
  layout = 'row',
  className = '',
}: {
  sample: ReadingValues;
  notes?: Partial<Record<MetricKey, string | null>>;
  layout?: keyof typeof LIST_LAYOUTS;
  className?: string;
}) {
  const debug = useDebugMode();
  const values = displayReadings(sample);
  if (!values) {
    return (
      <p className={`rounded-md bg-surface-muted p-4 text-sm text-ink-muted ${className}`}>—</p>
    );
  }
  return (
    <dl className={`grid gap-2 ${LIST_LAYOUTS[layout]} ${className}`}>
      {debug && values.estimated && <EstimatedNote className="col-span-full" />}
      {METRIC_KEYS.map((key) => {
        const Icon = METRIC_ICONS[key];
        const note = notes?.[key];
        return (
          <div key={key} className="rounded-md bg-surface-muted px-3 py-2">
            <dt className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
              <Icon size={16} className={METRICS[key].textClass} />
              {METRICS[key].label}
            </dt>
            <dd className="mt-0.5 text-xl font-semibold text-ink tabular">
              {formatReading(key, values[key])}
            </dd>
            {note && !values.estimated && <dd className="text-xs text-ink-muted">{note}</dd>}
          </div>
        );
      })}
    </dl>
  );
}
