import type { Sample } from '@sylvan/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef } from 'react';
import { setPushedDeviceStatus } from './deviceStatusStore';
import { queryKeys, useLatestSample } from './queries';
import { useLiveSocket, useSocketSnapshot } from './socketContext';

/**
 * Called whenever a new sample is known to exist, from either the WebSocket event or the polling
 * fallback. Refreshes every sample-dependent query.
 */
export async function handleNewSample(queryClient: QueryClient, sample: Sample) {
  queryClient.setQueryData(queryKeys.sample(sample.id), sample);
  queryClient.setQueryData(queryKeys.latest(), sample);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.samples() }),
    queryClient.invalidateQueries({ queryKey: [...queryKeys.all, 'stats'] }),
  ]);
}

/** A sample changed after upload (its photo verdict arrived): refresh everything showing it. */
export async function handleUpdatedSample(queryClient: QueryClient, sample: Sample) {
  queryClient.setQueryData(queryKeys.sample(sample.id), sample);
  queryClient.setQueryData(queryKeys.latest(), (latest: Sample | null | undefined) =>
    latest?.id === sample.id ? sample : latest,
  );
  await queryClient.invalidateQueries({ queryKey: queryKeys.samples() });
}

/**
 * Keeps the app up to date from both sources and announces each new sample exactly once:
 * the socket pushes `sample.created` and `device.status`, while the polled "latest sample"
 * query covers the case where WebSockets are unavailable.
 */
export function useLiveUpdates(onNewSample: (sample: Sample) => void) {
  const queryClient = useQueryClient();
  const socket = useLiveSocket();
  const { status } = useSocketSnapshot();
  const latest = useLatestSample();
  const announcedId = useRef<number | null>(null);
  const notify = useEffectEvent(onNewSample);

  /** Returns true when this sample is new to the page (so it is worth announcing). */
  const announce = useEffectEvent((sample: Sample) => {
    if (announcedId.current !== null && sample.id <= announcedId.current) return false;
    const first = announcedId.current === null;
    announcedId.current = sample.id;
    // Opening the app is not news; only announce samples that arrive afterwards.
    if (!first) notify(sample);
    return !first;
  });

  // WebSocket path.
  useEffect(() => {
    if (!socket) return;
    return socket.subscribe((message) => {
      if (message.type === 'sample.created') {
        void handleNewSample(queryClient, message.sample);
        announce(message.sample);
      } else if (message.type === 'sample.updated') {
        void handleUpdatedSample(queryClient, message.sample);
      } else if (message.type === 'hello' || message.type === 'device.status') {
        setPushedDeviceStatus(message.device);
      }
    });
  }, [socket, queryClient]);

  // Anything published while the socket was down was missed, so refresh on every (re)connect.
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = status === 'open';
    if (open && !wasOpen.current) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.all });
    }
    wasOpen.current = open;
  }, [status, queryClient]);

  // Polling path (also sets the baseline for the announcement guard).
  const sample = latest.data;
  useEffect(() => {
    if (sample === undefined) return;
    if (sample === null) {
      announcedId.current ??= 0;
      return;
    }
    // Without a socket this is how new samples are discovered, so refresh the lists too.
    if (announce(sample)) void handleNewSample(queryClient, sample);
  }, [sample, queryClient]);

  return latest;
}
