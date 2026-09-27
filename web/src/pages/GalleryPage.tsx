import type { Sample } from '@sylvan/shared';
import { useMemo, useRef, useState } from 'react';
import { Lightbox } from '../components/Lightbox';
import { Button } from '../components/ui/Button';
import { IconGallery } from '../components/ui/Icons';
import { CompactReadings } from '../components/ui/Readings';
import { RelativeTime } from '../components/ui/RelativeTime';
import { SamplePhoto } from '../components/ui/SamplePhoto';
import { LoadingRegion, Skeleton } from '../components/ui/Skeleton';
import { ClassificationBadge } from '../components/ui/ClassificationBadge';
import { StatusBadge } from '../components/ui/StatusBadge';
import { StatusFilter } from '../components/ui/StatusFilter';
import { EmptyState, ErrorState } from '../components/ui/States';
import { GALLERY_PAGE_SIZE } from '../lib/constants';
import { formatDateTime, formatNumber } from '../lib/format';
import { useInfiniteSamples } from '../lib/queries';
import { rangeLabel } from '../lib/range';
import { useFilters } from '../lib/useFilters';
import { useInfiniteScroll } from '../lib/useInfiniteScroll';

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5';

function GalleryCard({
  sample,
  onOpen,
}: {
  sample: Sample;
  onOpen: (element: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        onOpen(event.currentTarget);
      }}
      data-sample-id={sample.id}
      className="group block w-full overflow-hidden rounded-lg border border-border bg-surface text-left shadow-card transition-colors hover:border-border-strong"
      aria-label={`Open photo for sample #${sample.id}, ${sample.ok ? 'OK' : 'failed'}, ${formatDateTime(sample.createdAt)}`}
    >
      <SamplePhoto sample={sample} />
      <div className="space-y-1.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold tabular">#{sample.id}</span>
          <span className="flex flex-wrap justify-end gap-1">
            <ClassificationBadge sample={sample} />
            <StatusBadge ok={sample.ok} />
          </span>
        </div>
        <CompactReadings sample={sample} />
        <p className="text-xs text-ink-muted">
          <RelativeTime value={sample.createdAt} />
        </p>
      </div>
    </button>
  );
}

export default function GalleryPage() {
  const { range, apiRange, status, setStatus, setRange, linkSearch } = useFilters();
  const query = useInfiniteSamples({
    ...apiRange,
    status,
    hasPhoto: true,
    limit: GALLERY_PAGE_SIZE,
  });
  const samples = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openerId = useRef<number | null>(null);

  const loadMore = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  };
  const sentinel = useInfiniteScroll(loadMore, query.hasNextPage && !query.isError);

  let content;
  if (query.isPending) {
    content = (
      <LoadingRegion label="Loading photos" className={GRID}>
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="overflow-hidden rounded-lg border border-border bg-surface">
            <Skeleton className="aspect-[4/3] rounded-none" />
            <div className="space-y-2 p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </LoadingRegion>
    );
  } else if (query.isError && samples.length === 0) {
    content = (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        title="Could not load photos"
      />
    );
  } else if (samples.length === 0) {
    content = (
      <EmptyState
        icon={<IconGallery size={32} />}
        title="No photos in this range yet"
        message="The rover uploads a photo each time it finds an object. Try a longer range or another status."
        action={
          range.preset !== 'all' || status !== 'all' ? (
            <Button
              variant="primary"
              onClick={() => {
                setStatus('all');
                setRange({ preset: 'all' });
              }}
            >
              Show all photos
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <>
        <ul className={GRID}>
          {samples.map((sample, index) => (
            <li key={sample.id}>
              <GalleryCard
                sample={sample}
                onOpen={() => {
                  openerId.current = sample.id;
                  setOpenIndex(index);
                }}
              />
            </li>
          ))}
        </ul>
        <div ref={sentinel} className="mt-6 flex flex-col items-center gap-2">
          {query.isFetchNextPageError && (
            <p role="alert" className="text-sm text-failed">
              Could not load more photos.
            </p>
          )}
          {query.hasNextPage ? (
            <Button onClick={loadMore} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            <p className="text-sm text-ink-muted">
              All {formatNumber(samples.length)} photos loaded
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <title>Gallery · Sylvan</title>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Gallery</h1>
          <p className="mt-1 text-sm text-ink-muted">Samples with photos · {rangeLabel(range)}</p>
        </div>
        <StatusFilter value={status} onChange={setStatus} />
      </div>
      {content}
      <Lightbox
        samples={samples}
        index={openIndex}
        onIndexChange={(index) => {
          if (index !== null) openerId.current = samples[index]?.id ?? openerId.current;
          setOpenIndex(index);
        }}
        returnFocus={() =>
          document.querySelector<HTMLElement>(`[data-sample-id="${String(openerId.current)}"]`)
        }
        onReachEnd={loadMore}
        linkSearch={linkSearch}
      />
    </>
  );
}
