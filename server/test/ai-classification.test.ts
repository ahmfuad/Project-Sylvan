import type { Sample } from '@sylvan/shared';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClassifierError,
  createOpenAiClassifier,
  verdictFromCompletion,
  type AiVerdict,
  type PhotoClassifier,
} from '../src/services/aiClassifier.js';
import { fixtureJpeg, resetDatabase, uploadHeaders } from './helpers.js';
import { createRealtimeContext, type RealtimeContext } from './realtime-helpers.js';

const completion = (content: string | null, top?: [string, number][]) => ({
  choices: [
    {
      message: { content },
      logprobs: top
        ? {
            content: [
              {
                token: top[0]?.[0] ?? '',
                logprob: Math.log(top[0]?.[1] ?? 1),
                top_logprobs: top.map(([token, p]) => ({ token, logprob: Math.log(p) })),
              },
            ],
          }
        : null,
    },
  ],
});

describe('verdictFromCompletion', () => {
  it('reads the label and sums the probability of every spelling of it', () => {
    const verdict = verdictFromCompletion(
      completion('TREE', [
        ['TREE', 0.9],
        [' tree', 0.04],
        ['OBJECT', 0.05],
        ['UN', 0.01],
      ]),
      'gpt-4.1-mini',
    );
    expect(verdict).toEqual({
      label: 'tree',
      confidence: 0.94,
      model: 'gpt-4.1-mini',
      note: 'TREE',
    });
  });

  it('handles split answer tokens (UNC + LEAR) and missing logprobs', () => {
    expect(verdictFromCompletion(completion('UNCLEAR', [['UNC', 1]]), 'm')).toMatchObject({
      label: 'unclear',
      confidence: 1,
    });
    expect(verdictFromCompletion(completion('Object.'), 'm')).toMatchObject({
      label: 'object',
      confidence: null,
    });
  });

  it('reports empty, refused and unexpected answers as error', () => {
    expect(verdictFromCompletion(completion(''), 'm')).toMatchObject({
      label: 'error',
      note: 'empty answer',
    });
    expect(verdictFromCompletion(completion('Maybe a cat'), 'm')).toMatchObject({
      label: 'error',
    });
    expect(verdictFromCompletion({}, 'm').label).toBe('error');
  });
});

describe('createOpenAiClassifier', () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends the photo with logprobs on and parses the answer', async () => {
    let sent: Record<string, unknown> = {};
    const classifier = createOpenAiClassifier({
      apiKey: 'sk-test-0123456789abcdefghij',
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify(completion('OBJECT', [['OBJECT', 0.8]])));
      }) as unknown as typeof fetch,
    });
    const verdict = await classifier.classify(Buffer.from([0xff, 0xd8, 1, 2]));
    expect(verdict).toMatchObject({ label: 'object', confidence: 0.8, model: 'gpt-4.1-mini' });
    expect(sent).toMatchObject({ model: 'gpt-4.1-mini', logprobs: true, top_logprobs: 5 });
    expect(JSON.stringify(sent)).toContain('data:image/jpeg;base64,/9gBAg==');
  });

  it('marks rate limits and outages retryable, bad requests not, and hides 401 bodies', async () => {
    const key = 'sk-test-0123456789abcdefghij';
    const error = (status: number) =>
      createOpenAiClassifier({
        apiKey: key,
        fetch: respond(status, { error: { message: `Incorrect API key provided: ${key}` } }),
      })
        .classify(Buffer.from([0xff, 0xd8]))
        .then(
          () => {
            throw new Error('expected a ClassifierError');
          },
          (caught: unknown) => caught as ClassifierError,
        );
    expect(await error(429)).toMatchObject({ retryable: true });
    expect(await error(503)).toMatchObject({ retryable: true });
    expect(await error(400)).toMatchObject({ retryable: false });
    const unauthorized = await error(401);
    expect(unauthorized.message).toBe('OpenAI HTTP 401: API key rejected');
    expect(unauthorized.message).not.toContain(key);
  });
});

describe('classification worker', () => {
  let ctx: RealtimeContext;
  afterEach(async () => {
    await ctx.close();
  });

  const fake = (
    answer: () => AiVerdict | Promise<AiVerdict>,
  ): PhotoClassifier & { calls: number } => {
    const classifier = {
      model: 'fake-model',
      calls: 0,
      async classify() {
        classifier.calls++;
        return answer();
      },
    };
    return classifier;
  };

  const upload = async (id: string, photo = true) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=1&t=30&h=60&l=100',
      headers: {
        ...uploadHeaders({ 'x-upload-id': id }),
        ...(photo ? { 'content-type': 'image/jpeg' } : {}),
      },
      ...(photo ? { payload: await fixtureJpeg() } : {}),
    });

  const sampleOf = async (id: number) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/samples/${String(id)}` })).json<Sample>();

  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('classifies a new upload, stores the confidence and pushes sample.updated', async () => {
    const classifier = fake(() => ({
      label: 'tree',
      confidence: 0.94,
      model: 'fake-model',
      note: 'TREE',
    }));
    ctx = await createRealtimeContext({ photoClassifier: classifier });
    await resetDatabase(ctx.sql);
    const viewer = await ctx.viewer();

    expect((await upload('a-1')).statusCode).toBe(201);
    const message = await viewer.next<{ sample: Sample }>(
      (m) => m.type === 'sample.updated' && (m.sample as Sample).ai !== null,
    );
    expect(message.sample.ai).toMatchObject({
      label: 'tree',
      confidence: 0.94,
      model: 'fake-model',
      note: 'TREE',
    });
    expect((await sampleOf(1)).ai?.classifiedAt).toMatch(/Z$/);

    // Samples without a photo are never sent.
    expect((await upload('a-2', false)).statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(classifier.calls).toBe(1);
    expect((await sampleOf(2)).ai).toBeNull();
  });

  it('pushes the verdict to the rover over its socket, matched by upload id', async () => {
    ctx = await createRealtimeContext({
      photoClassifier: fake(() => ({
        label: 'object',
        confidence: 0.88,
        model: 'fake-model',
        note: 'OBJECT',
      })),
    });
    await resetDatabase(ctx.sql);
    const device = await ctx.device();
    const viewer = await ctx.viewer();
    await upload('boot9-4');
    const verdict = await device.next((m) => m.type === 'verdict');
    expect(verdict).toEqual({
      type: 'verdict',
      uploadId: 'boot9-4',
      label: 'object',
      confidence: 0.88,
    });
    // Viewers get the updated sample, never the device-only verdict message.
    await viewer.next((m) => m.type === 'sample.updated');
    expect(viewer.messages.some((m) => m.type === 'verdict' || m.type === 'verdict.ready')).toBe(
      false,
    );
  });

  it('retries temporary failures, then gives up with an error verdict', async () => {
    const classifier = fake(() => {
      throw new ClassifierError('OpenAI HTTP 503: overloaded', true);
    });
    ctx = await createRealtimeContext({
      photoClassifier: classifier,
      classificationWorker: { retryDelayMs: 10, maxAttempts: 3 },
    });
    await resetDatabase(ctx.sql);
    await upload('r-1');
    await until(async () => (await sampleOf(1)).ai !== null);
    expect(classifier.calls).toBe(3);
    expect((await sampleOf(1)).ai).toMatchObject({
      label: 'error',
      confidence: null,
      note: 'OpenAI HTTP 503: overloaded',
    });
  });

  it('backfills older photos and marks a missing photo file as an error', async () => {
    // Uploaded while classification was off.
    const before = await createRealtimeContext({});
    ctx = before;
    await resetDatabase(before.sql);
    await upload('old-1');
    await upload('old-2');
    const [missing] = await before.sql<{ photo_key: string }[]>`
      SELECT photo_key FROM samples WHERE id = 1
    `;
    await rm(`${before.photoDir}/${missing?.photo_key ?? ''}`);

    // Turned on later, reading the same photo folder.
    const classifier = fake(() => ({
      label: 'object',
      confidence: 0.7,
      model: 'fake-model',
      note: 'OBJECT',
    }));
    ctx = await createRealtimeContext({ photoClassifier: classifier, photoDir: before.photoDir });
    try {
      await until(async () => (await sampleOf(1)).ai !== null && (await sampleOf(2)).ai !== null);
      expect((await sampleOf(2)).ai).toMatchObject({ label: 'object', confidence: 0.7 });
      expect((await sampleOf(1)).ai).toMatchObject({
        label: 'error',
        note: 'photo file missing on server',
      });
    } finally {
      await before.close();
    }
  });
});
