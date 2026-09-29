import { readFile } from 'node:fs/promises';
import type { Classification, PlantHealth } from '@sylvan/shared';
import type { Sql } from '../db/client.js';
import { ClassifierError, type PhotoClassifier } from './aiClassifier.js';
import type { EventBus } from './events.js';
import type { PhotoStorage } from './photoStorage.js';
import type { SamplesService } from './samples.js';

/**
 * Classifies every stored photo that has no server verdict yet, newest first, one at a time.
 *
 * The database is the queue (`ai_label IS NULL AND photo_key IS NOT NULL`), so nothing is lost
 * across restarts and photos uploaded before this feature existed are backfilled. A new upload
 * calls `kick()` to start work at once instead of waiting for the next idle check.
 */
export interface ClassificationWorker {
  start(): void;
  kick(): void;
  /** Stops after the photo in progress (if any) and waits for it. */
  stop(): Promise<void>;
}

interface PendingRow {
  id: string;
  photo_key: string;
  ai_attempts: number;
  upload_id: string | null;
}

export function createClassificationWorker(deps: {
  sql: Sql;
  storage: PhotoStorage;
  samples: SamplesService;
  events: EventBus;
  classifier: PhotoClassifier;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  /** Attempts per photo before it is marked `error`. */
  maxAttempts?: number;
  /** How long to pause after a retryable failure (rate limit, outage). */
  retryDelayMs?: number;
  /** How often to look for work when idle (covers anything a kick missed). */
  idleMs?: number;
}): ClassificationWorker {
  const { sql, storage, samples, events, classifier, log } = deps;
  const maxAttempts = deps.maxAttempts ?? 3;
  const retryDelayMs = deps.retryDelayMs ?? 30_000;
  const idleMs = deps.idleMs ?? 5 * 60_000;

  let running = false;
  /** Set by kick(); checked before sleeping so a kick that lands between a check and the
   *  sleep is not lost (the photo would otherwise wait for the next idle check). */
  const pending = { kicked: false };
  const wasKicked = () => pending.kicked;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
      timer.unref();
    }).finally(() => {
      if (timer) clearTimeout(timer);
      timer = null;
      wake = null;
    });

  async function announce(id: string) {
    const sample = await samples.get(id);
    if (sample) events.publish({ type: 'sample.updated', sample });
  }

  async function saveResult(
    row: PendingRow,
    result: {
      label: Classification;
      health?: PlantHealth | null;
      healthConfidence?: number | null;
      confidence: number | null;
      model: string | null;
      note: string;
    },
  ) {
    const id = row.id;
    await sql`
      UPDATE samples
      SET ai_label = ${result.label}, ai_health = ${result.health ?? null},
          ai_health_confidence = ${result.healthConfidence ?? null},
          ai_confidence = ${result.confidence},
          ai_model = ${result.model}, ai_note = ${result.note.slice(0, 300)},
          ai_attempts = ai_attempts + 1, ai_classified_at = now()
      WHERE id = ${id}::bigint
    `;
    await announce(id);
    // The rover waits for this to show the verdict on its OLED.
    if (row.upload_id) {
      events.publish({
        type: 'verdict.ready',
        uploadId: row.upload_id,
        label: result.label,
        health: result.health ?? null,
        healthConfidence: result.healthConfidence ?? null,
        confidence: result.confidence,
      });
    }
  }

  /** Returns 'done', 'idle' (nothing to do) or 'backoff' (retryable failure). */
  async function step(): Promise<'done' | 'idle' | 'backoff'> {
    const [row] = await sql<PendingRow[]>`
      SELECT id, photo_key, ai_attempts, upload_id FROM samples
      WHERE ai_label IS NULL AND photo_key IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `;
    if (!row) return 'idle';

    let photo: Buffer;
    try {
      photo = await readFile(storage.resolve(row.photo_key));
    } catch (error) {
      log.warn({ sampleId: row.id, err: error }, 'photo file unreadable; not classifying');
      await saveResult(row, {
        label: 'error',
        confidence: null,
        model: null,
        note: 'photo file missing on server',
      });
      return 'done';
    }

    try {
      const verdict = await classifier.classify(photo);
      await saveResult(row, verdict);
      log.info(
        {
          sampleId: row.id,
          label: verdict.label,
          health: verdict.health,
          confidence: verdict.confidence,
        },
        'photo classified',
      );
      return 'done';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof ClassifierError ? error.retryable : true;
      const attempts = row.ai_attempts + 1;
      if (!retryable || attempts >= maxAttempts) {
        log.warn({ sampleId: row.id, attempts, err: message }, 'photo classification failed');
        await saveResult(row, {
          label: 'error',
          confidence: null,
          model: classifier.model,
          note: message,
        });
        return 'done';
      }
      log.warn({ sampleId: row.id, attempts, err: message }, 'photo classification will retry');
      await sql`
        UPDATE samples SET ai_attempts = ${attempts}, ai_note = ${message.slice(0, 300)}
        WHERE id = ${row.id}::bigint
      `;
      return 'backoff';
    }
  }

  async function run() {
    while (running) {
      pending.kicked = false;
      let outcome: 'done' | 'idle' | 'backoff';
      try {
        outcome = await step();
      } catch (error) {
        // Database trouble: wait and try again rather than spin.
        log.error({ err: error }, 'classification worker error');
        outcome = 'backoff';
      }
      // stop() wakes any sleep below, so the loop condition ends it promptly.
      if (outcome === 'idle') {
        if (!wasKicked()) await sleep(idleMs);
      } else if (outcome === 'backoff') await sleep(retryDelayMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    kick() {
      pending.kicked = true;
      wake?.();
    },
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
  };
}
