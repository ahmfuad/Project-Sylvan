import type { Sample } from '@sylvan/shared';
import { Link } from 'react-router';
import { Card, CardHeader } from '../../components/ui/Card';
import { IconArrowUpRight } from '../../components/ui/Icons';
import { ReadingList } from '../../components/ui/Readings';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SamplePhoto } from '../../components/ui/SamplePhoto';
import { ConditionsBadge } from '../../components/ui/ConditionsBadge';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { formatDateTime } from '../../lib/format';

export function LatestSample({ sample, linkSearch }: { sample: Sample; linkSearch: string }) {
  return (
    <Card aria-labelledby="latest-heading" className="overflow-hidden">
      <CardHeader
        id="latest-heading"
        title="Latest sample"
        actions={
          <Link
            to={`/samples/${sample.id}${linkSearch}`}
            aria-label={`Details for sample #${sample.id}`}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-brand hover:underline"
          >
            Details
            <IconArrowUpRight size={16} />
          </Link>
        }
      />
      <div className="grid gap-4 p-4 sm:p-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:items-start">
        <SamplePhoto sample={sample} priority size="lg" className="rounded-md" />
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-semibold tabular">#{sample.id}</span>
            <StatusBadge ok={sample.ok} />
            <ConditionsBadge sample={sample} />
          </div>
          <p className="text-sm text-ink-muted">
            {formatDateTime(sample.createdAt)}
            <span aria-hidden="true"> · </span>
            <RelativeTime value={sample.createdAt} focusable />
          </p>
          <ReadingList sample={sample} layout="sidebar" />
        </div>
      </div>
    </Card>
  );
}
