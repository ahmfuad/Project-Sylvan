import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ButtonLink, buttonClass } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { IconChevronLeft, IconChevronRight, IconDownload } from '../components/ui/Icons';
import { ReadingList } from '../components/ui/Readings';
import { RelativeTime } from '../components/ui/RelativeTime';
import { SamplePhoto } from '../components/ui/SamplePhoto';
import { LoadingRegion, Skeleton } from '../components/ui/Skeleton';
import { ClassificationBadge, describeFailReason } from '../components/ui/ClassificationBadge';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState } from '../components/ui/States';
import { isNotFound } from '../lib/api';
import { compareToAverage } from '../lib/compare';
import { formatDateTime, formatNumber, formatUtc } from '../lib/format';
import { useNeighbors, useSample, useStats } from '../lib/queries';
import { rangeLabel } from '../lib/range';
import { useFilters } from '../lib/useFilters';
import { NotFoundContent } from './NotFoundPage';

function parseId(raw: string | undefined): number | null {
  return raw && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export default function SampleDetailPage() {
  const params = useParams();
  const id = parseId(params.id);
  const navigate = useNavigate();
  const { range, apiRange, timezone, linkSearch } = useFilters();
  const sample = useSample(id);
  const neighbors = useNeighbors(sample.data ? id : null);
  const stats = useStats({ ...apiRange, tz: timezone });

  const previousId = neighbors.data?.previousId ?? null;
  const nextId = neighbors.data?.nextId ?? null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const target =
        event.key === 'ArrowLeft' ? previousId : event.key === 'ArrowRight' ? nextId : null;
      if (target !== null) {
        event.preventDefault();
        void navigate(`/samples/${target}${linkSearch}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previousId, nextId, navigate, linkSearch]);

  if (id === null || isNotFound(sample.error)) {
    return (
      <>
        <title>Sample not found · Sylvan</title>
        <NotFoundContent
          title="Sample not found"
          message={
            id === null
              ? 'That is not a valid sample number.'
              : `There is no sample #${formatNumber(id)}. It may not have been uploaded yet.`
          }
        />
      </>
    );
  }

  if (sample.isPending) {
    return (
      <LoadingRegion
        label="Loading sample"
        className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      >
        <Skeleton className="aspect-[4/3]" />
        <div className="space-y-4">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
        </div>
      </LoadingRegion>
    );
  }

  if (sample.isError) {
    return (
      <ErrorState
        error={sample.error}
        onRetry={() => {
          void sample.refetch();
        }}
        title="Could not load this sample"
      />
    );
  }

  const data = sample.data;
  const averages = stats.data?.metrics;
  const notes =
    data.ok && averages
      ? {
          temperature: compareToAverage('temperature', data.temperature, averages.temperature.avg),
          humidity: compareToAverage('humidity', data.humidity, averages.humidity.avg),
          lux: compareToAverage('lux', data.lux, averages.lux.avg),
        }
      : undefined;

  const navLink = (targetId: number | null, direction: 'previous' | 'next') => {
    const label = direction === 'previous' ? 'Previous' : 'Next';
    const icon =
      direction === 'previous' ? <IconChevronLeft size={18} /> : <IconChevronRight size={18} />;
    if (targetId === null) {
      return (
        <span className={buttonClass('secondary', 'md', 'opacity-50')} aria-disabled="true">
          {direction === 'previous' && icon}
          {label}
          {direction === 'next' && icon}
        </span>
      );
    }
    return (
      <ButtonLink
        to={`/samples/${targetId}${linkSearch}`}
        aria-label={`${label}: sample #${targetId}`}
        aria-keyshortcuts={direction === 'previous' ? 'ArrowLeft' : 'ArrowRight'}
      >
        {direction === 'previous' && icon}
        {label}
        {direction === 'next' && icon}
      </ButtonLink>
    );
  };

  return (
    <>
      <title>{`Sample #${data.id} · Sylvan`}</title>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight tabular sm:text-3xl">
            Sample #{data.id}
          </h1>
          <StatusBadge ok={data.ok} className="text-sm" />
          <ClassificationBadge sample={data} className="text-sm" />
        </div>
        <nav aria-label="Sample navigation" className="flex gap-2">
          {navLink(previousId, 'previous')}
          {navLink(nextId, 'next')}
        </nav>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <Card aria-label="Photo" className="overflow-hidden">
          <SamplePhoto sample={data} priority size="lg" />
          {data.photoUrl && (
            <div className="flex justify-end p-3">
              <a
                href={data.photoUrl}
                download={`sylvan-sample-${data.id}.jpg`}
                className={buttonClass('secondary')}
              >
                <IconDownload size={16} />
                Download photo
              </a>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card aria-labelledby="time-heading" className="p-4 sm:p-6">
            <h2 id="time-heading" className="text-base font-semibold">
              Time
            </h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm tabular">
              <dt className="text-ink-muted">Local</dt>
              <dd>
                {formatDateTime(data.createdAt)} (<RelativeTime value={data.createdAt} focusable />)
              </dd>
              <dt className="text-ink-muted">UTC</dt>
              <dd>{formatUtc(data.createdAt)}</dd>
            </dl>
          </Card>

          <Card aria-labelledby="classification-heading" className="p-4 sm:p-6">
            <h2 id="classification-heading" className="text-base font-semibold">
              Photo classification
            </h2>
            {data.classification === null ? (
              <p className="mt-2 text-sm text-ink-muted">
                Waiting for the rover's verdict. It appears here on its own when it arrives.
              </p>
            ) : (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-muted">Verdict</dt>
                <dd>
                  <ClassificationBadge sample={data} />
                </dd>
                {data.classificationNote && (
                  <>
                    <dt className="text-ink-muted">Details</dt>
                    <dd className="break-words">{data.classificationNote}</dd>
                  </>
                )}
                {data.classifiedAt && (
                  <>
                    <dt className="text-ink-muted">Classified</dt>
                    <dd className="tabular">
                      <RelativeTime value={data.classifiedAt} />
                    </dd>
                  </>
                )}
              </dl>
            )}
            {!data.ok && (
              <div className="mt-4 border-t border-border pt-3 text-sm">
                <p className="font-medium">Why the readings failed</p>
                {data.failReason ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
                    {describeFailReason(data.failReason).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-muted">
                    Not reported (sent by older rover firmware).
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card aria-labelledby="readings-heading" className="p-4 sm:p-6">
            <h2 id="readings-heading" className="text-base font-semibold">
              Readings
            </h2>
            {data.ok && (
              <p className="mt-1 text-sm text-ink-muted">
                {stats.isPending
                  ? 'Loading range averages…'
                  : stats.isError
                    ? 'Range averages are unavailable.'
                    : `Compared with the average for ${rangeLabel(range).replace(/^L/, 'l')}.`}
              </p>
            )}
            <ReadingList sample={data} notes={notes} layout="sidebar" className="mt-4" />
          </Card>
        </div>
      </div>
      <p className="mt-6 hidden text-xs text-ink-muted md:block">
        Tip: use ← and → to move to the previous or next sample.
      </p>
    </>
  );
}
