import type { DeviceStatus, SampleListParams, StatsParams } from '@sylvan/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { LIVE_POLL_INTERVAL_MS } from './constants';
import { usePushedDeviceStatus } from './deviceStatusStore';
import { useSocketOpen } from './socketContext';

/**
 * Query keys. Everything that depends on the set of samples lives under `samples` or `stats`, so
 * a new upload can refresh it all with one invalidation (see live.ts).
 */
export const queryKeys = {
  all: ['sylvan'] as const,
  samples: () => [...queryKeys.all, 'samples'] as const,
  sampleList: (params: SampleListParams) => [...queryKeys.samples(), 'list', params] as const,
  sampleInfinite: (params: Omit<SampleListParams, 'cursor'>) =>
    [...queryKeys.samples(), 'infinite', params] as const,
  sample: (id: number) => [...queryKeys.samples(), 'detail', id] as const,
  neighbors: (id: number) => [...queryKeys.samples(), 'neighbors', id] as const,
  stats: (params: StatsParams) => [...queryKeys.all, 'stats', params] as const,
  latest: () => [...queryKeys.all, 'latest'] as const,
  device: () => [...queryKeys.all, 'device'] as const,
  explore: (params: StatsParams & { bins?: number }) =>
    [...queryKeys.all, 'explore', params] as const,
};

/**
 * Polling interval for live data: paused while the WebSocket is open, because the server pushes
 * `sample.created` and `device.status` instead. Everything falls back to polling when the socket
 * is closed or blocked.
 */
export const livePollInterval = (socketOpen: boolean): number | false =>
  socketOpen ? false : LIVE_POLL_INTERVAL_MS;

export function useSamples(params: SampleListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.sampleList(params),
    queryFn: ({ signal }) => api.samples(params, signal),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useInfiniteSamples(params: Omit<SampleListParams, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.sampleInfinite(params),
    queryFn: ({ pageParam, signal }) =>
      api.samples(pageParam ? { ...params, cursor: pageParam } : params, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useSample(id: number | null) {
  return useQuery({
    queryKey: queryKeys.sample(id ?? -1),
    queryFn: ({ signal }) => api.sample(id ?? -1, signal),
    enabled: id !== null,
    // Samples change only when their photo verdict arrives, which the socket pushes.
    staleTime: Infinity,
  });
}

export function useNeighbors(id: number | null) {
  return useQuery({
    queryKey: queryKeys.neighbors(id ?? -1),
    queryFn: ({ signal }) => api.neighbors(id ?? -1, signal),
    enabled: id !== null,
  });
}

export function useStats(params: StatsParams) {
  const socketOpen = useSocketOpen();
  return useQuery({
    queryKey: queryKeys.stats(params),
    queryFn: ({ signal }) => api.stats(params, signal),
    placeholderData: keepPreviousData,
    refetchInterval: livePollInterval(socketOpen),
  });
}

/**
 * Rover status: pushed over the socket while it is open, polled from `GET /api/device` otherwise
 * (so the page still works when WebSockets are blocked).
 */
export function useDeviceStatus(): { data: DeviceStatus | undefined; isPending: boolean } {
  const socketOpen = useSocketOpen();
  const pushed = usePushedDeviceStatus();
  const query = useQuery<DeviceStatus>({
    queryKey: queryKeys.device(),
    queryFn: ({ signal }) => api.device(signal),
    refetchInterval: livePollInterval(socketOpen),
    enabled: !(socketOpen && pushed !== null),
    staleTime: 5000,
  });
  const data = pushed ?? query.data;
  return { data, isPending: data === undefined && query.isPending };
}

export function useExplore(params: StatsParams & { bins?: number }) {
  return useQuery({
    queryKey: queryKeys.explore(params),
    queryFn: ({ signal }) => api.explore(params, signal),
    placeholderData: keepPreviousData,
  });
}

/** The newest sample overall, polled so the app notices new uploads without a socket. */
export function useLatestSample() {
  const socketOpen = useSocketOpen();
  return useQuery({
    queryKey: queryKeys.latest(),
    queryFn: async ({ signal }) => (await api.samples({ limit: 1 }, signal)).items[0] ?? null,
    refetchInterval: livePollInterval(socketOpen),
  });
}
