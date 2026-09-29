import type { Sample, StatsResponse } from '@sylvan/shared';

export function makeSample(overrides: Partial<Sample> & { id: number }): Sample {
  return {
    createdAt: '2026-09-17T08:00:00.000Z',
    ok: true,
    temperature: 24.5,
    humidity: 61,
    lux: 820,
    photoUrl: `/photos/2026/09/${String(overrides.id).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`,
    photoBytes: 18_000,
    failReason: null,
    fallback: null,
    classification: null,
    classificationNote: null,
    classifiedAt: null,
    ai: null,
    ...overrides,
  };
}

export function makeStats(overrides: Partial<StatsResponse> = {}): StatsResponse {
  return {
    range: { from: '2026-09-10T18:00:00.000Z', to: null, tz: 'Asia/Dhaka' },
    totals: { samples: 12, ok: 10, failed: 2, successRate: 0.8333, withPhoto: 9 },
    metrics: {
      temperature: { min: 21, avg: 24.3, max: 28.1, count: 10 },
      humidity: { min: 50, avg: 62.4, max: 71, count: 10 },
      lux: { min: 40, avg: 1250, max: 8000, count: 10 },
    },
    previousPeriod: {
      totals: { samples: 10, ok: 9, failed: 1, successRate: 0.9 },
      metrics: { temperature: { avg: 23.1 }, humidity: { avg: 64 }, lux: { avg: null } },
    },
    latest: makeSample({ id: 42, createdAt: '2026-09-17T08:05:00.000Z' }),
    lastUploadAt: '2026-09-17T08:05:00.000Z',
    daily: [
      {
        date: '2026-09-16',
        samples: 5,
        ok: 4,
        failed: 1,
        avgTemperature: 24,
        avgHumidity: 60,
        avgLux: 900,
      },
      {
        date: '2026-09-17',
        samples: 7,
        ok: 6,
        failed: 1,
        avgTemperature: 24.5,
        avgHumidity: 64,
        avgLux: 1500,
      },
    ],
    dailyTruncated: false,
    ...overrides,
  };
}

export const emptyStats = (): StatsResponse =>
  makeStats({
    totals: { samples: 0, ok: 0, failed: 0, successRate: null, withPhoto: 0 },
    metrics: {
      temperature: { min: null, avg: null, max: null, count: 0 },
      humidity: { min: null, avg: null, max: null, count: 0 },
      lux: { min: null, avg: null, max: null, count: 0 },
    },
    latest: null,
    lastUploadAt: null,
    daily: [],
  });
