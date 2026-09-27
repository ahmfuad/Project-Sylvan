import type { DeviceLog } from '@sylvan/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeFailReason } from '../components/ui/ClassificationBadge';
import { api } from '../lib/api';
import { LiveSocket } from '../lib/socket';
import { LiveSocketProvider } from '../lib/socketContext';
import DebugPage from '../pages/DebugPage';
import { FakeWebSocket, FakeWebSocketImpl } from './fakeSocket';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { deviceLogs: vi.fn() } };
});

const line = (id: number, overrides: Partial<DeviceLog> = {}): DeviceLog => ({
  id,
  receivedAt: `2026-09-27T10:00:${String(id).padStart(2, '0')}.000Z`,
  source: 'esp32',
  level: 'info',
  bootId: '111',
  deviceMs: id * 100,
  message: `line ${id}`,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  FakeWebSocket.reset();
});

function renderDebug() {
  const socket = new LiveSocket({ url: 'ws://test/ws/live', WebSocketImpl: FakeWebSocketImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LiveSocketProvider socket={socket}>
        <DebugPage />
      </LiveSocketProvider>
    </QueryClientProvider>,
  );
}

const rows = () => within(screen.getByRole('log')).getAllByRole('row');

describe('DebugPage', () => {
  it('shows stored lines oldest first, then appends live ones', async () => {
    vi.mocked(api.deviceLogs).mockResolvedValue({
      items: [line(2, { source: 'atmega', level: 'warn', message: 'DHT11 FAIL code=4' }), line(1)],
      nextBefore: null,
    });
    renderDebug();
    expect(await screen.findByText('DHT11 FAIL code=4')).toBeInTheDocument();
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('line 1'),
      expect.stringContaining('DHT11 FAIL code=4'),
    ]);
    expect(rows()[1]).toHaveTextContent('AVR');

    await act(async () => {
      FakeWebSocket.last.accept();
      FakeWebSocket.last.emit({
        type: 'log.appended',
        entries: [line(3, { bootId: '222', message: 'ESP32 boot 222' })],
      });
      await Promise.resolve();
    });
    expect(screen.getByText('ESP32 boot 222')).toBeInTheDocument();
    expect(screen.getByText('ESP32 rebooted (boot 222)')).toBeInTheDocument();
  });

  it('filters by text on the page and by level on the server', async () => {
    vi.mocked(api.deviceLogs).mockResolvedValue({
      items: [line(2, { message: 'upload ok' }), line(1, { message: 'OpenAI: TREE' })],
      nextBefore: null,
    });
    renderDebug();
    await screen.findByText('upload ok');

    await userEvent.type(screen.getByRole('searchbox'), 'openai');
    expect(screen.queryByText('upload ok')).not.toBeInTheDocument();
    expect(screen.getByText('OpenAI: TREE')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Level'), 'warn');
    expect(api.deviceLogs).toHaveBeenLastCalledWith(
      { limit: 300, level: 'warn' },
      expect.any(AbortSignal),
    );
  });
});

describe('describeFailReason', () => {
  it('explains the rover codes', () => {
    expect(describeFailReason('dht=4,lux=ok')).toEqual([
      'Temperature/humidity sensor (DHT11): bit timing timeout',
      'Light sensor (BH1750): OK',
    ]);
    expect(describeFailReason('dht=skip,lux=fail')[1]).toBe(
      'Light sensor (BH1750): I²C read failed',
    );
  });
});
