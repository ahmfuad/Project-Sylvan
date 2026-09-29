import type { Sample } from '@sylvan/shared';

export interface DisplayReadings {
  temperature: number;
  humidity: number;
  lux: number;
  /** True when the values are the fallback averages of nearby samples, not measured. */
  estimated: boolean;
}

/**
 * The readings to show for a sample: the measured ones, or for a failed sample the server's
 * fallback averages. Null when there is nothing to show.
 */
export function displayReadings(
  sample: Pick<Sample, 'ok' | 'temperature' | 'humidity' | 'lux' | 'fallback'>,
): DisplayReadings | null {
  if (sample.ok && sample.temperature !== null && sample.humidity !== null && sample.lux !== null) {
    return {
      temperature: sample.temperature,
      humidity: sample.humidity,
      lux: sample.lux,
      estimated: false,
    };
  }
  return sample.fallback ? { ...sample.fallback, estimated: true } : null;
}
