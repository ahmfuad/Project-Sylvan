import type { Classification, Sample } from '@sylvan/shared';
import { IconAlert, IconLeaf } from './Icons';

const STYLES: Record<Classification, { label: string; className: string }> = {
  tree: { label: 'Tree', className: 'bg-brand-soft text-ink' },
  object: { label: 'Object', className: 'bg-surface-muted text-ink' },
  unclear: { label: 'Unclear', className: 'bg-warn-soft text-ink' },
  error: { label: 'Not classified', className: 'bg-failed-soft text-failed' },
};

/** The OpenAI verdict for a sample's photo; renders nothing until the verdict arrives. */
export function ClassificationBadge({
  sample,
  className = '',
}: {
  sample: Pick<Sample, 'classification'>;
  className?: string;
}) {
  if (sample.classification === null) return null;
  const { label, className: tone } = STYLES[sample.classification];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone} ${className}`}
    >
      {sample.classification === 'tree' ? (
        <IconLeaf size={13} strokeWidth={2.5} />
      ) : sample.classification === 'error' ? (
        <IconAlert size={13} strokeWidth={2.5} />
      ) : null}
      <span className="sr-only">Photo classified as </span>
      {label}
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
