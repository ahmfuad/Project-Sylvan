import type { Sample } from '@sylvan/shared';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClassifierError,
  createOpenAiClassifier,
  HEALTH_PROMPT,
  readChoice,
  TYPE_PROMPT,
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

describe('readChoice', () => {
  const TYPE = { T: 'tree', O: 'object' } as const;

  it('reads the answer and sums the probability of every spelling of it', () => {
    const result = readChoice(
      completion('TREE', [
        ['TREE', 0.9],
        [' tree', 0.04],
        ['OBJECT', 0.06],
      ]),
      TYPE,
    );
    expect(result).toEqual({ ok: true, value: 'tree', confidence: 0.94, answer: 'TREE' });
  });

  it('handles split tokens (HEAL + THY) and missing logprobs', () => {
    const HEALTH = { H: 'healthy', S: 'unhealthy' } as const;
    expect(readChoice(completion('HEALTHY', [['HEAL', 1]]), HEALTH)).toMatchObject({
      value: 'healthy',
      confidence: 1,
    });
    expect(readChoice(completion('Sick.'), HEALTH)).toMatchObject({
      value: 'unhealthy',
      confidence: null,
    });
  });

  it('rejects empty, refused and unexpected answers', () => {
    expect(readChoice(completion(''), TYPE)).toEqual({ ok: false, note: 'empty answer' });
    expect(readChoice(completion('Maybe a cat'), TYPE)).toMatchObject({ ok: false });
    expect(readChoice({}, TYPE)).toMatchObject({ ok: false });
  });
});

describe('createOpenAiClassifier', () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  /** A fake OpenAI that answers each prompt from a table, recording the prompts it saw. */
  const fakeOpenAi = (answers: Record<string, [string, number]>) => {
    const prompts: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: { content: unknown }[];
      } & Record<string, unknown>;
      const prompt = body.messages[0]?.content as string;
      prompts.push(prompt);
      bodies.push(body);
      const [answer, p] = answers[prompt === TYPE_PROMPT ? 'type' : 'health'] ?? ['?', 1];
      return new Response(JSON.stringify(completion(answer, [[answer, p]])));
    }) as unknown as typeof fetch;
    return { fetch: fakeFetch, prompts, bodies };
  };

  it('asks tree-or-object, then health for trees, each with its own confidence', async () => {
    const openAi = fakeOpenAi({ type: ['TREE', 0.97], health: ['SICK', 0.88] });
    const classifier = createOpenAiClassifier({
      apiKey: 'sk-test-0123456789abcdefghij',
      fetch: openAi.fetch,
    });
    const verdict = await classifier.classify(Buffer.from([0xff, 0xd8, 1, 2]));
    expect(verdict).toEqual({
      label: 'tree',
      confidence: 0.97,
      health: 'unhealthy',
      healthConfidence: 0.88,
      model: 'gpt-4.1-mini',
      note: 'TREE / SICK',
    });
    expect(openAi.prompts).toEqual([TYPE_PROMPT, HEALTH_PROMPT]);
    expect(openAi.bodies[0]).toMatchObject({
      model: 'gpt-4.1-mini',
      logprobs: true,
      top_logprobs: 5,
    });
    expect(JSON.stringify(openAi.bodies[0])).toContain('data:image/jpeg;base64,/9gBAg==');
    // The health call shows the two labelled example plants before the photo to judge.
    const health = openAi.bodies[1] as { messages: { role: string; content: unknown }[] };
    expect(health.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(health.messages[2]?.content).toBe('SICK');
    expect(health.messages[4]?.content).toBe('HEALTHY');
  });

  it('makes a single call for objects, with no health', async () => {
    const openAi = fakeOpenAi({ type: ['OBJECT', 0.99] });
    const verdict = await createOpenAiClassifier({
      apiKey: 'sk-test-0123456789abcdefghij',
      fetch: openAi.fetch,
    }).classify(Buffer.from([0xff, 0xd8]));
    expect(verdict).toMatchObject({
      label: 'object',
      confidence: 0.99,
      health: null,
      healthConfidence: null,
    });
    expect(openAi.prompts).toEqual([TYPE_PROMPT]);
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
      health: 'healthy',
      healthConfidence: 0.9,
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
      health: 'healthy',
      healthConfidence: 0.9,
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
        health: null,
        healthConfidence: null,
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
      health: null,
      healthConfidence: null,
      confidence: 0.88,
    });
    // Viewers get the updated sample, never the device-only verdict message.
    await viewer.next((m) => m.type === 'sample.updated');
    expect(viewer.messages.some((m) => m.type === 'verdict' || m.type === 'verdict.ready')).toBe(
      false,
    );
  });

  it('returns the verdict in the upload response with ?wait=verdict, also on a retry', async () => {
    ctx = await createRealtimeContext({
      photoClassifier: fake(() => ({
        label: 'tree',
        health: null,
        healthConfidence: null,
        confidence: 0.99,
        model: 'm',
        note: 'TREE',
      })),
    });
    await resetDatabase(ctx.sql);
    const send = async () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/samples?ok=1&t=30&h=60&l=100&wait=verdict',
        headers: { ...uploadHeaders({ 'x-upload-id': 'w-1' }), 'content-type': 'image/jpeg' },
        payload: await fixtureJpeg(),
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({
      id: 1,
      photo: true,
      verdict: { label: 'tree', health: null, healthConfidence: null, confidence: 0.99 },
    });
    // The rover retries when a response is lost: same upload id, same sample, same verdict.
    const retry = await send();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({
      id: 1,
      photo: true,
      verdict: { label: 'tree', health: null, healthConfidence: null, confidence: 0.99 },
    });
  });

  it('answers verdict null when classification takes longer than the wait', async () => {
    ctx = await createRealtimeContext({
      verdictWaitMs: 50,
      photoClassifier: fake(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              resolve({
                label: 'object',
                health: null,
                healthConfidence: null,
                confidence: 0.5,
                model: 'm',
                note: 'OBJECT',
              });
            }, 300),
          ),
      ),
    });
    await resetDatabase(ctx.sql);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=1&t=30&h=60&l=100&wait=verdict',
      headers: { ...uploadHeaders({ 'x-upload-id': 'slow-1' }), 'content-type': 'image/jpeg' },
      payload: await fixtureJpeg(),
    });
    expect(res.json()).toEqual({ id: 1, photo: true, verdict: null });
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('re-sends a recent verdict when the rover reconnects', async () => {
    ctx = await createRealtimeContext({
      photoClassifier: fake(() => ({
        label: 'object',
        health: null,
        healthConfidence: null,
        confidence: 0.9,
        model: 'm',
        note: 'OBJECT',
      })),
    });
    await resetDatabase(ctx.sql);
    await upload('gone-1'); // classified while the rover was offline
    await until(async () => (await sampleOf(1)).ai !== null);
    const device = await ctx.device();
    expect(await device.next((m) => m.type === 'verdict')).toMatchObject({
      uploadId: 'gone-1',
      label: 'object',
    });
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
      health: null,
      healthConfidence: null,
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
