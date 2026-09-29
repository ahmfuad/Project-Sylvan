import { describe, expect, it } from 'vitest';
import { evaluateConditions, rate } from '../lib/conditions';
import { displayReadings } from '../lib/readings';

describe('evaluateConditions', () => {
  it('rates each reading and takes the worst as the verdict', () => {
    expect(evaluateConditions({ temperature: 26, humidity: 60, lux: 5000 })).toEqual({
      verdict: 'good',
      ratings: { temperature: 'good', humidity: 'good', lux: 'good' },
    });
    expect(evaluateConditions({ temperature: 35, humidity: 60, lux: 5000 }).verdict).toBe('fair');
    expect(evaluateConditions({ temperature: 26, humidity: 95, lux: 900 }).verdict).toBe('poor');
  });

  it('includes the band edges', () => {
    expect(rate('temperature', 18)).toBe('good');
    expect(rate('temperature', 32)).toBe('good');
    expect(rate('temperature', 38)).toBe('fair');
    expect(rate('temperature', 38.1)).toBe('poor');
    expect(rate('lux', 199)).toBe('poor');
    expect(rate('lux', 200)).toBe('fair');
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
