import type { Classification, DeviceLog, Sample } from '@sylvan/shared';

export type AppEvent =
  | { type: 'sample.created'; sample: Sample }
  | { type: 'sample.updated'; sample: Sample }
  | { type: 'log.appended'; entries: DeviceLog[] }
  /** For the rover only (sent over /ws/device), never to viewers. */
  | { type: 'verdict.ready'; uploadId: string; label: Classification; confidence: number | null };

export type EventHandler = (event: AppEvent) => void;

/**
 * Minimal in-process event bus so routes can announce changes without importing WebSocket code.
 * Publishing with no subscribers (for example when realtime is disabled in tests) does nothing.
 */
export interface EventBus {
  publish(event: AppEvent): void;
  subscribe(handler: EventHandler): () => void;
  hasSubscribers(): boolean;
}

export function createEventBus(onError: (error: unknown) => void = () => undefined): EventBus {
  const handlers = new Set<EventHandler>();
  return {
    publish(event) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          onError(error);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    hasSubscribers: () => handlers.size > 0,
  };
}
