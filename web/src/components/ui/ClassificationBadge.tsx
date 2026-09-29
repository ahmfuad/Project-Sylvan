import type { Classification, Sample } from '@sylvan/shared';
import { IconLeaf } from './Icons';

const STYLES: Record<Classification, { label: string; className: string }> = {
  tree: { label: 'Tree', className: 'bg-brand-soft text-ink' },
  object: { label: 'Object', className: 'bg-surface-muted text-ink' },
  unclear: { label: 'Unclear', className: 'bg-warn-soft text-ink' },
  error: { label: 'Not classified', className: 'bg-failed-soft text-failed' },
};

/** Formats a 0-1 confidence as a whole percentage, e.g. 0.943 -> "94%". */
export const formatConfidence = (confidence: number) => `${String(Math.round(confidence * 100))}%`;

/**
 * The photo verdict: the server's (with its confidence) when it has one, otherwise the rover's
 * own. `source="rover"` always shows the rover's. Renders nothing until a verdict exists.
 */
export function ClassificationBadge({
  sample,
  source = 'best',
  className = '',
}: {
  sample: Pick<Sample, 'classification' | 'ai'>;
  source?: 'best' | 'rover';
  className?: string;
}) {
  const server = source === 'best' ? sample.ai : null;
  const verdict = server?.label ?? sample.classification;
  if (verdict === null) return null;
  // Only the two verdicts are shown: tree/object (+ health for trees).
  if (verdict !== 'tree' && verdict !== 'object') return null;
  const health = verdict === 'tree' ? (server?.health ?? null) : null;
  const { label, className: base } = STYLES[verdict];
  // An unhealthy tree is flagged in the warning colour so it stands out in lists.
  const tone = health === 'unhealthy' ? 'bg-warn-soft text-ink' : base;
  const confidence = server?.confidence ?? null;
  const healthConfidence = server?.healthConfidence ?? null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone} ${className}`}
    >
      {verdict === 'tree' && <IconLeaf size={13} strokeWidth={2.5} />}
      <span className="sr-only">Photo classified as </span>
      {label}
      {confidence !== null && (
        <span className="font-normal tabular">
          <span className="sr-only">, confidence</span> {formatConfidence(confidence)}
        </span>
      )}
      {health && (
        <span>
          · {health === 'healthy' ? 'Healthy' : 'Unhealthy'}
          {healthConfidence !== null && (
            <span className="font-normal tabular">
              <span className="sr-only">, confidence</span> {formatConfidence(healthConfidence)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

const DHT_CODES: Record<string, string> = {
  ok: 'OK',
  '1': 'no response (line never went low)',
  '2': 'no response (line never went high)',
  '3': 'no start of data',
  '4': 'bit timing timeout',
  '5': 'checksum mismatch',
  skip: 'not read in time',
};
const LUX_CODES: Record<string, string> = {
  ok: 'OK',
  fail: 'I²C read failed',
  skip: 'not read in time',
};

/** Turns a rover failure reason such as `dht=4,lux=ok` into readable parts. */
export function describeFailReason(reason: string): string[] {
  return reason.split(',').map((part) => {
    const [key = '', value = ''] = part.split('=');
    if (key === 'dht') return `Temperature/humidity sensor (DHT11): ${DHT_CODES[value] ?? value}`;
    if (key === 'lux') return `Light sensor (BH1750): ${LUX_CODES[value] ?? value}`;
    return part;
  });
}
