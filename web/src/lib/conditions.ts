import type { StatsResponse } from '@sylvan/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { MetricKey } from './constants';
import { queryKeys } from './queries';
import { useFilters } from './useFilters';

/**
 * Whether the measured air is good for the trees, judged against the current averages (the
 * selected date range, as on the Overview page): a reading at or above its average is good.
 *   all three at or above average -> good; one below -> fair; two or more below -> poor.
 */
export type Rating = 'good' | 'fair' | 'poor';
export type Level = 'above' | 'below';

export type Averages = Record<MetricKey, number>;

export interface Conditions {
  verdict: Rating;
  levels: Record<MetricKey, Level>;
}

export function evaluateConditions(
  readings: Record<MetricKey, number>,
  averages: Averages,
): Conditions {
  const levels = {
    temperature: readings.temperature >= averages.temperature ? 'above' : 'below',
    humidity: readings.humidity >= averages.humidity ? 'above' : 'below',
    lux: readings.lux >= averages.lux ? 'above' : 'below',
  } satisfies Record<MetricKey, Level>;
  const below = Object.values(levels).filter((level) => level === 'below').length;
  return { verdict: below === 0 ? 'good' : below === 1 ? 'fair' : 'poor', levels };
}

/** The averages from stats, or null while loading / when there are no readings yet. */
export function averagesFrom(stats: StatsResponse | undefined): Averages | null {
  const t = stats?.metrics.temperature.avg;
  const h = stats?.metrics.humidity.avg;
  const l = stats?.metrics.lux.avg;
  return t == null || h == null || l == null ? null : { temperature: t, humidity: h, lux: l };
}

/**
 * Current averages for the selected range. Reads the Overview page's stats query from the cache
 * and never refetches when a badge mounts, so a page full of cards costs at most one request.
 */
export function useConditionAverages(): Averages | null {
  const { apiRange, timezone } = useFilters();
  const params = { ...apiRange, tz: timezone };
  const stats = useQuery({
    queryKey: queryKeys.stats(params),
    queryFn: ({ signal }) => api.stats(params, signal),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  return averagesFrom(stats.data);
}
