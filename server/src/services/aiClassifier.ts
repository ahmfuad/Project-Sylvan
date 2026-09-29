import type { Classification, PlantHealth } from '@sylvan/shared';

/**
 * Classifies a rover photo with the OpenAI Chat Completions API, in two steps:
 *   1. TREE or OBJECT
 *   2. for trees only: HEALTHY or SICK
 * Each confidence is not the model's opinion of itself: it is the probability the model gave its
 * one-word answer, read from the first answer token's log-probabilities (the two answers of each
 * step start with different letters). That needs a model that returns logprobs, such as the
 * gpt-4.1 / gpt-4o families; with other models the confidences are null.
 */

export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';

export const TYPE_PROMPT =
  'You look at one photo taken by a small rover in a rooftop garden of potted trees. The camera ' +
  'faces sideways and photos are close-ups, often blurred or dark. Decide whether the thing ' +
  'closest to the camera is part of a potted tree or plant, or something else. Answer TREE for ' +
  'leaves, stems, a trunk, or a pot, tub or planter holding soil, pebbles or a plant (the rover ' +
  'often sees only the side of the tub). Answer OBJECT for anything else: boxes, packets, ' +
  'bottles, baskets, boards, the floor, walls, people, hands or tools, including printed ' +
  'pictures of plants. Reply with exactly one word: TREE or OBJECT.';

export const HEALTH_PROMPT =
  'This photo from a rooftop garden rover shows a potted tree or plant, as a blurry close-up. ' +
  "Judge the plant's health from its branches, stems and leaves; blur and lighting say nothing " +
  'about health. A healthy plant here has plenty of green, firm leaves. Answer SICK if the plant ' +
  'has few or no leaves on its branches or stems (bare or leafless twigs, even if the stems are ' +
  'green), or leaves that are yellow, brown, pale, dry, spotted, curled or wilting, or pests. ' +
  'Answer HEALTHY if it has plenty of green, firm leaves. If the photo shows only the pot and ' +
  'soil with no stems or leaves at all, answer HEALTHY. Reply with exactly one word: HEALTHY or SICK.';

export interface AiVerdict {
  /** `tree` or `object`; `error` only when no answer could be read. */
  label: Classification;
  /** Probability (0-1) of the tree/object answer, or null without logprobs. */
  confidence: number | null;
  /** Trees only. */
  health: PlantHealth | null;
  /** Probability (0-1) of the health answer; trees only. */
  healthConfidence: number | null;
  model: string;
  /** The raw answers, e.g. "TREE / SICK", kept for debugging only. */
  note: string;
}

export interface PhotoClassifier {
  readonly model: string;
  /** Throws ClassifierError; `retryable` says whether trying again later may succeed. */
  classify(photo: Buffer): Promise<AiVerdict>;
}

export class ClassifierError extends Error {
  override name = 'ClassifierError';
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** First letter of an answer or token such as "SICK", " sick" or "HEAL", upper-cased. */
function initialOf(text: string): string | null {
  return /[A-Za-z]/.exec(text)?.[0]?.toUpperCase() ?? null;
}

interface CompletionJson {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    logprobs?: {
      content?:
        | { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[]
        | null;
    } | null;
  }[];
}

export type ChoiceResult<T> =
  { ok: true; value: T; confidence: number | null; answer: string } | { ok: false; note: string };

/**
 * Reads a one-word answer from a chat completion and maps it by its first letter (e.g. T/O, H/S).
 * The confidence sums every top candidate for the first token that starts the same answer
 * ("TREE", "Tree", " tree"...), so the score is not split between spellings. Pure, so it is
 * unit-tested directly.
 */
export function readChoice<T>(json: unknown, answers: Record<string, T>): ChoiceResult<T> {
  const choice = (json as CompletionJson).choices?.[0];
  const answer = choice?.message?.content?.trim() ?? '';
  if (!answer) {
    const refusal = choice?.message?.refusal;
    return { ok: false, note: refusal ? `refused: ${refusal.slice(0, 120)}` : 'empty answer' };
  }
  const initial = initialOf(answer);
  const value = initial === null ? undefined : answers[initial];
  if (initial === null || value === undefined) {
    return { ok: false, note: `unexpected answer: ${answer.slice(0, 60)}` };
  }

  const first = choice?.logprobs?.content?.[0];
  let confidence: number | null = null;
  if (first) {
    const candidates = first.top_logprobs?.length ? first.top_logprobs : [first];
    const mass = candidates
      .filter((candidate) => initialOf(candidate.token) === initial)
      .reduce((sum, candidate) => sum + Math.exp(candidate.logprob), 0);
    confidence = Math.round(Math.min(1, mass) * 1000) / 1000;
  }
  return { ok: true, value, confidence, answer: answer.slice(0, 20) };
}

const TYPE_ANSWERS: Record<string, 'tree' | 'object'> = { T: 'tree', O: 'object' };
const HEALTH_ANSWERS: Record<string, PlantHealth> = { H: 'healthy', S: 'unhealthy' };

export function createOpenAiClassifier(options: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
}): PhotoClassifier {
  const model = options.model ?? DEFAULT_AI_MODEL;
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** One chat completion for a one-word answer about the photo; throws ClassifierError. */
  async function ask(prompt: string, image: string): Promise<unknown> {
    const body = {
      model,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: image, detail: 'low' } }],
        },
      ],
      max_completion_tokens: 3,
      temperature: 0,
      logprobs: true,
      top_logprobs: 5,
    };

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ClassifierError(`OpenAI request failed: ${reason}`, true);
    }

    const text = await response.text();
    if (!response.ok) {
      // Never echo a 401 body: it quotes part of the key.
      let message = response.status === 401 ? 'API key rejected' : text.slice(0, 160);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (response.status !== 401 && parsed.error?.message) {
          message = parsed.error.message.slice(0, 160);
        }
      } catch {
        // Keep the raw snippet.
      }
      throw new ClassifierError(
        `OpenAI HTTP ${String(response.status)}: ${message}`,
        response.status === 429 || response.status >= 500,
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ClassifierError('OpenAI returned invalid JSON', true);
    }
  }

  return {
    model,
    async classify(photo) {
      const image = `data:image/jpeg;base64,${photo.toString('base64')}`;
      const kind = readChoice(await ask(TYPE_PROMPT, image), TYPE_ANSWERS);
      if (!kind.ok) {
        return {
          label: 'error',
          confidence: null,
          health: null,
          healthConfidence: null,
          model,
          note: kind.note,
        };
      }
      if (kind.value !== 'tree') {
        return {
          label: kind.value,
          confidence: kind.confidence,
          health: null,
          healthConfidence: null,
          model,
          note: kind.answer,
        };
      }
      const health = readChoice(await ask(HEALTH_PROMPT, image), HEALTH_ANSWERS);
      return {
        label: 'tree',
        confidence: kind.confidence,
        health: health.ok ? health.value : null,
        healthConfidence: health.ok ? health.confidence : null,
        model,
        note: health.ok ? `${kind.answer} / ${health.answer}` : `${kind.answer} / ${health.note}`,
      };
    },
  };
}
