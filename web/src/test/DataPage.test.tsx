import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { setDebugMode } from '../lib/debugMode';
import DataPage, { sortRows } from '../pages/DataPage';
import { makeSample } from './fixtures';
import { renderRoute } from './render';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { samples: vi.fn(), sample: vi.fn(), neighbors: vi.fn(), stats: vi.fn() },
  };
});

const samplesMock = vi.mocked(api.samples);
const rows = [
  makeSample({ id: 3, temperature: 22 }),
  makeSample({ id: 2, ok: false, temperature: null, humidity: null, lux: null }),
  makeSample({ id: 1, temperature: 26 }),
];

afterEach(() => {
  setDebugMode(false);
});

beforeEach(() => {
  vi.clearAllMocks();
  samplesMock.mockResolvedValue({ items: rows, nextCursor: null });
});

function exportParams() {
  const link = screen.getByRole('link', { name: 'Export CSV' });
  const url = new URL(link.getAttribute('href') ?? '', 'http://localhost');
  expect(url.pathname).toBe('/api/export.csv');
  return Object.fromEntries(url.searchParams);
}

describe('DataPage', () => {
  it('builds the CSV export link from the active filters and timezone', async () => {
    renderRoute(<DataPage />, {
      path: '/data',
      url: '/data?status=ok&from=2026-09-01&to=2026-09-10',
    });
    await screen.findAllByText('#3');
    expect(exportParams()).toEqual({
      status: 'ok',
      from: '2026-08-31T18:00:00.000Z',
      to: '2026-09-10T17:59:59.999Z',
      tz: 'Asia/Dhaka',
    });
  });

  it('hides the OK/Failed filter unless debug mode is on', async () => {
    renderRoute(<DataPage />, { path: '/data', url: '/data?range=all' });
    await screen.findAllByText('#3');
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
  });

  it('updates the export link when filters change (debug mode)', async () => {
    setDebugMode(true);
    renderRoute(<DataPage />, { path: '/data', url: '/data?range=all' });
    await screen.findAllByText('#3');
    expect(exportParams()).toEqual({ tz: 'Asia/Dhaka' });

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Failed' }),
    );
    expect(exportParams()).toEqual({ status: 'failed', tz: 'Asia/Dhaka' });
    expect(samplesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', order: 'desc' }),
      expect.anything(),
    );
  });

  it('sorts other columns within loaded rows, with missing readings last', () => {
    const byTemp = sortRows(rows, { key: 'temperature', direction: 'asc' });
    expect(byTemp.map((row) => row.id)).toEqual([3, 1, 2]);
    expect(sortRows(rows, { key: 'temperature', direction: 'desc' }).map((row) => row.id)).toEqual([
      1, 3, 2,
    ]);
    expect(sortRows(rows, { key: 'time', direction: 'desc' })).toBe(rows);
  });
});
