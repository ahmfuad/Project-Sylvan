import type { Classification } from '@sylvan/shared';

/**
 * Classifies a rover photo with the OpenAI Chat Completions API.
 *
 * The model answers with one word (TREE, OBJECT or UNCLEAR). The confidence is not the model's
 * opinion of itself: it is the probability the model assigned to its answer, read from the
 * answer's first-token log-probabilities (the three answers start with different letters, so the
 * first token decides the label). That needs a model that returns logprobs, such as the
 * gpt-4.1 / gpt-4o families; reasoning models (gpt-5.x) do not, and then confidence is null.
 */

export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';

export const AI_PROMPT =
  "You classify one photo taken by a small rover in a rooftop garden. The rover's camera faces " +
  'sideways and every photo is a close-up, usually blurred by motion and low light; blur alone is ' +
  'normal and is NOT a reason to answer UNCLEAR. ' +
  'Answer TREE if any living plant is visible close to the camera: leaves, stems, grass-like ' +
  'blades, a trunk, or a pot, tub or planter with a plant in it. ' +
  'Answer OBJECT if the photo shows no living plant: boxes, packets, bottles, baskets, boards, ' +
  'the floor, walls, people, hands or tools, including printed pictures of plants. ' +
  'Answer UNCLEAR only if the photo is almost completely black, white or featureless. ' +
  'Reply with exactly one word: TREE, OBJECT or UNCLEAR.';

export interface AiVerdict {
  label: Classification;
  /** 0-1, or null when the model reported no logprobs. */
  confidence: number | null;
  model: string;
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

const LABEL_BY_INITIAL: Record<string, Classification> = { T: 'tree', O: 'object', U: 'unclear' };

/** Maps an answer or token such as "TREE", " tree" or "UNC" to its label by its first letter. */
function labelOf(text: string): Classification | null {
  const initial = /[A-Za-z]/.exec(text)?.[0]?.toUpperCase();
  return initial ? (LABEL_BY_INITIAL[initial] ?? null) : null;
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

/** Turns a chat completion response into a verdict. Pure, so it is unit-tested directly. */
export function verdictFromCompletion(json: unknown, model: string): AiVerdict {
  const choice = (json as CompletionJson).choices?.[0];
  const answer = choice?.message?.content?.trim() ?? '';
  if (!answer) {
    const refusal = choice?.message?.refusal;
    return {
      label: 'error',
      confidence: null,
      model,
      note: refusal ? `refused: ${refusal.slice(0, 120)}` : 'empty answer',
    };
  }

  const label = labelOf(answer);
  if (!label) {
    return {
      label: 'error',
      confidence: null,
      model,
      note: `unexpected answer: ${answer.slice(0, 60)}`,
    };
  }

  // Probability mass of every top candidate for the first token that means the same label
  // ("TREE", "Tree", " tree"...), so the score is not split between spellings.
  const first = choice?.logprobs?.content?.[0];
  let confidence: number | null = null;
  if (first) {
    const candidates = first.top_logprobs?.length ? first.top_logprobs : [first];
    const mass = candidates
      .filter((candidate) => labelOf(candidate.token) === label)
      .reduce((sum, candidate) => sum + Math.exp(candidate.logprob), 0);
    confidence = Math.round(Math.min(1, mass) * 1000) / 1000;
  }

  return { label, confidence, model, note: answer.slice(0, 60) };
}

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

  return {
    model,
    async classify(photo) {
      const body = {
        model,
        messages: [
          { role: 'system', content: AI_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${photo.toString('base64')}`,
                  detail: 'low',
                },
              },
            ],
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

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ClassifierError('OpenAI returned invalid JSON', true);
      }
      return verdictFromCompletion(json, model);
    },
  };
}
