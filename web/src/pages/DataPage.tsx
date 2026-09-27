import type { Sample, SampleOrder } from '@sylvan/shared';
import { useId, useMemo, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, buttonClass } from '../components/ui/Button';
import { IconDownload, IconSort, IconTable } from '../components/ui/Icons';
import { CompactReadings } from '../components/ui/Readings';
import { RelativeTime } from '../components/ui/RelativeTime';
import { SamplePhoto } from '../components/ui/SamplePhoto';
import { LoadingRegion, Skeleton } from '../components/ui/Skeleton';
import { ClassificationBadge } from '../components/ui/ClassificationBadge';
import { StatusBadge } from '../components/ui/StatusBadge';
import { StatusFilter } from '../components/ui/StatusFilter';
import { EmptyState, ErrorState } from '../components/ui/States';
import { exportCsvUrl } from '../lib/api';
import { DATA_PAGE_SIZE, METRICS, type MetricKey } from '../lib/constants';
import { formatDateTime, formatNumber, formatReading } from '../lib/format';
import { useInfiniteSamples } from '../lib/queries';
import { rangeLabel } from '../lib/range';
import { useFilters } from '../lib/useFilters';

type SortKey = 'time' | 'id' | 'status' | MetricKey;
interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const COLUMN_LABELS: Record<SortKey, string> = {
  id: 'ID',
  time: 'Time',
  status: 'Status',
  temperature: 'Temperature',
  humidity: 'Humidity',
  lux: 'Light',
};

/** Sorts loaded rows by a column; missing readings always sort last. */
export function sortRows(rows: Sample[], sort: SortState): Sample[] {
  if (sort.key === 'time') return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  const value = (sample: Sample): number | null => {
    if (sort.key === 'id') return sample.id;
    if (sort.key === 'status') return sample.ok ? 1 : 0;
    return sample[sort.key as MetricKey];
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * sign || b.id - a.id;
  });
}

function JumpToSample() {
  const navigate = useNavigate();
  const { linkSearch } = useFilters();
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim().replace(/^#/, '');
    if (!/^[1-9]\d{0,15}$/.test(trimmed)) {
      setError('Enter a sample number such as 42.');
      return;
    }
    setError(null);
    void navigate(`/samples/${trimmed}${linkSearch}`);
  };

  return (
    <form onSubmit={submit} className="flex items-start gap-2" noValidate>
      <div>
        <label htmlFor={id} className="sr-only">
          Jump to sample number
        </label>
        <input
          id={id}
          inputMode="numeric"
          placeholder="Sample #"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="min-h-11 w-28 rounded-md border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-muted"
        />
        {error && (
          <p id={`${id}-error`} className="mt-1 text-xs text-failed">
            {error}
          </p>
        )}
      </div>
      <Button type="submit">Go</Button>
    </form>
  );
}

function SortHeader({
  column,
  sort,
  onSort,
  className = '',
}: {
  column: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`border-b border-border px-2 py-1 font-semibold text-ink-muted ${className}`}
    >
      <button
        type="button"
        onClick={() => {
          onSort(column);
        }}
        className={`inline-flex min-h-11 items-center gap-1 rounded-sm px-1 hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {COLUMN_LABELS[column]}
        {active ? (
          <span aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</span>
        ) : (
          <IconSort size={14} className="opacity-50" />
        )}
      </button>
    </th>
  );
}

export default function DataPage() {
  const {
    range,
    apiRange,
    status,
    setStatus,
    setRange,
    linkSearch,
    timezone,
    searchParams,
    setSearchParams,
  } = useFilters();
  const order: SampleOrder = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  const query = useInfiniteSamples({ ...apiRange, status, order, limit: DATA_PAGE_SIZE });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const [columnSort, setColumnSort] = useState<SortState | null>(null);
  const sort = useMemo<SortState>(
    () => columnSort ?? { key: 'time', direction: order },
    [columnSort, order],
  );
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const onSort = (key: SortKey) => {
    if (key === 'time') {
      // Time order comes from the server, so it applies to every page.
      const nextOrder = sort.key === 'time' && order === 'desc' ? 'asc' : 'desc';
      setColumnSort(null);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if (nextOrder === 'asc') next.set('order', 'asc');
        else next.delete('order');
        return next;
      });
      return;
    }
    setColumnSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'id' ? 'desc' : 'asc' },
    );
  };

  const csvHref = exportCsvUrl({
    status: status === 'all' ? undefined : status,
    ...apiRange,
    tz: timezone,
  });

  let content;
  if (query.isPending) {
    content = (
      <LoadingRegion label="Loading samples" className="space-y-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-14" />
        ))}
      </LoadingRegion>
    );
  } else if (query.isError && rows.length === 0) {
    content = (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        title="Could not load samples"
      />
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={<IconTable size={32} />}
        title="No samples in this range yet"
        message="The rover uploads one each time it finds an object."
        action={
          range.preset !== 'all' || status !== 'all' ? (
            <Button
              variant="primary"
              onClick={() => {
                setStatus('all');
                setRange({ preset: 'all' });
              }}
            >
              Show all samples
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <>
        <p className="mb-2 text-sm text-ink-muted" aria-live="polite">
          Showing {formatNumber(rows.length)} samples
          {sort.key === 'time'
            ? `, ${order === 'desc' ? 'newest' : 'oldest'} first`
            : `, sorted by ${COLUMN_LABELS[sort.key].toLowerCase()} within the loaded rows only`}
          .
        </p>

        {/* Phones: stacked cards */}
        <ul className="space-y-2 md:hidden">
          {sorted.map((sample) => (
            <li key={sample.id}>
              <Link
                to={`/samples/${sample.id}${linkSearch}`}
                className="flex gap-3 rounded-lg border border-border bg-surface p-2 shadow-card"
              >
                <div className="w-24 shrink-0 overflow-hidden rounded-md">
                  <SamplePhoto sample={sample} size="sm" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold tabular">#{sample.id}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      <ClassificationBadge sample={sample} />
                      <StatusBadge ok={sample.ok} />
                    </span>
                  </div>
                  <p className="text-xs text-ink-muted tabular">
                    {formatDateTime(sample.createdAt)}
                  </p>
                  <CompactReadings sample={sample} />
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {/* Tablets and up: table */}
        <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-card md:block">
          <table className="w-full text-left text-sm tabular">
            <caption className="sr-only">
              Samples,{' '}
              {sort.key === 'time'
                ? 'sorted by time'
                : `sorted by ${COLUMN_LABELS[sort.key]} within loaded rows`}
            </caption>
            <thead>
              <tr>
                <SortHeader column="id" sort={sort} onSort={onSort} className="pl-4" />
                <SortHeader column="time" sort={sort} onSort={onSort} />
                <SortHeader column="status" sort={sort} onSort={onSort} />
                <SortHeader
                  column="temperature"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortHeader column="humidity" sort={sort} onSort={onSort} className="text-right" />
                <SortHeader column="lux" sort={sort} onSort={onSort} className="text-right" />
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1 pr-4 font-semibold text-ink-muted"
                >
                  Photo
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((sample) => (
                <tr
                  key={sample.id}
                  className="border-b border-border last:border-0 hover:bg-surface-muted/60"
                >
                  <td className="py-1 pr-2 pl-4">
                    <Link
                      to={`/samples/${sample.id}${linkSearch}`}
                      className="inline-flex min-h-11 items-center rounded-sm font-semibold text-brand hover:underline"
                    >
                      #{sample.id}
                    </Link>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="block">{formatDateTime(sample.createdAt)}</span>
                    <RelativeTime value={sample.createdAt} className="text-xs text-ink-muted" />
                  </td>
                  <td className="px-2 py-1">
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge ok={sample.ok} />
                      <ClassificationBadge sample={sample} />
                    </span>
                  </td>
                  {(['temperature', 'humidity', 'lux'] as const).map((key) => (
                    <td key={key} className="px-2 py-1 text-right whitespace-nowrap">
                      {sample[key] === null ? (
                        <span className="text-ink-muted">
                          —
                          <span className="sr-only">
                            no {METRICS[key].label.toLowerCase()} reading
                          </span>
                        </span>
                      ) : (
                        formatReading(key, sample[key])
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1 pr-4">
                    <div className="w-16 overflow-hidden rounded-sm">
                      <SamplePhoto sample={sample} size="sm" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col items-center gap-2">
          {query.isFetchNextPageError && (
            <p role="alert" className="text-sm text-failed">
              Could not load more samples.
            </p>
          )}
          {query.hasNextPage ? (
            <Button
              onClick={() => {
                void query.fetchNextPage();
              }}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            <p className="text-sm text-ink-muted">End of results</p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <title>Data · Sylvan</title>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Data</h1>
          <p className="mt-1 text-sm text-ink-muted">All samples · {rangeLabel(range)}</p>
        </div>
        <a href={csvHref} className={buttonClass('primary')} download>
          <IconDownload size={16} />
          Export CSV
        </a>
      </div>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <StatusFilter value={status} onChange={setStatus} />
        <JumpToSample />
      </div>
      {content}
    </>
  );
}
