import type { MetricKey } from './constants';

/**
 * Whether the measured air is good for the trees, from fixed ranges for potted trees on a
 * rooftop. Each reading is rated good / fair / poor; the overall verdict is the worst rating.
 * Change the ranges here.
 */
export type Rating = 'good' | 'fair' | 'poor';

interface Range {
  /** Inclusive bounds of the good band. */
  good: [number, number];
  /** Inclusive bounds of the fair band (outside it is poor). */
  fair: [number, number];
}

export const CONDITION_RANGES: Record<MetricKey, Range> = {
  temperature: { good: [18, 32], fair: [10, 38] },
  humidity: { good: [40, 80], fair: [30, 90] },
  lux: { good: [2000, Infinity], fair: [200, Infinity] },
};

export interface Conditions {
  verdict: Rating;
  ratings: Record<MetricKey, Rating>;
}

export function rate(metric: MetricKey, value: number): Rating {
  const { good, fair } = CONDITION_RANGES[metric];
  if (value >= good[0] && value <= good[1]) return 'good';
  if (value >= fair[0] && value <= fair[1]) return 'fair';
  return 'poor';
}

export function evaluateConditions(readings: Record<MetricKey, number>): Conditions {
  const ratings = {
    temperature: rate('temperature', readings.temperature),
    humidity: rate('humidity', readings.humidity),
    lux: rate('lux', readings.lux),
  };
  const values = Object.values(ratings);
  const verdict: Rating = values.includes('poor')
    ? 'poor'
    : values.includes('fair')
      ? 'fair'
      : 'good';
  return { verdict, ratings };
}
