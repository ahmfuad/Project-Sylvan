import { describe, expect, it } from 'vitest';
import { averagesFrom, evaluateConditions } from '../lib/conditions';
import { displayReadings } from '../lib/readings';
import { makeStats } from './fixtures';

const averages = { temperature: 30, humidity: 70, lux: 300 };

describe('evaluateConditions', () => {
  it('is good when every reading is at or above its current average', () => {
    expect(evaluateConditions({ temperature: 30, humidity: 70, lux: 300 }, averages)).toEqual({
      verdict: 'good',
      levels: { temperature: 'above', humidity: 'above', lux: 'above' },
    });
  });

  it('is fair with one reading below average and poor with two or more', () => {
    expect(evaluateConditions({ temperature: 31, humidity: 75, lux: 40 }, averages).verdict).toBe(
      'fair',
    );
    expect(evaluateConditions({ temperature: 29, humidity: 60, lux: 400 }, averages).verdict).toBe(
      'poor',
    );
  });

  it('takes the averages from stats, and none while there are no readings', () => {
    expect(averagesFrom(makeStats())).toEqual({ temperature: 24.3, humidity: 62.4, lux: 1250 });
    expect(averagesFrom(undefined)).toBeNull();
  });
});

describe('displayReadings', () => {
  it('uses measured values, or the fallback for failed samples', () => {
    const base = { temperature: null, humidity: null, lux: null, fallback: null };
    expect(displayReadings({ ...base, ok: true, temperature: 30, humidity: 70, lux: 400 })).toEqual(
      { temperature: 30, humidity: 70, lux: 400, estimated: false },
    );
    expect(
      displayReadings({
        ...base,
        ok: false,
        fallback: { temperature: 29, humidity: 65, lux: 300 },
      }),
    ).toEqual({ temperature: 29, humidity: 65, lux: 300, estimated: true });
    expect(displayReadings({ ...base, ok: false })).toBeNull();
  });
});
