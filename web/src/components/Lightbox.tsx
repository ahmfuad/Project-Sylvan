import * as Dialog from '@radix-ui/react-dialog';
import type { Sample } from '@sylvan/shared';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../lib/format';
import { buttonClass } from './ui/Button';
import { IconChevronLeft, IconChevronRight, IconDownload, IconX } from './ui/Icons';
import { ReadingList } from './ui/Readings';
import { RelativeTime } from './ui/RelativeTime';
import { SamplePhoto } from './ui/SamplePhoto';
import { StatusBadge } from './ui/StatusBadge';
import { ConditionsBadge } from './ui/ConditionsBadge';

const SWIPE_MIN_PX = 50;

interface LightboxProps {
  samples: Sample[];
  /** Index of the open sample, or null when closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
  /** Element to focus after closing (normally the card that opened the lightbox). */
  returnFocus?: () => HTMLElement | null;
  /** Called when the user moves past the last loaded photo, so more can be fetched. */
  onReachEnd?: () => void;
  linkSearch?: string;
}

/**
 * Full-screen photo viewer. Radix Dialog provides the focus trap, Escape to close, background
 * `aria-hidden` and scroll locking; arrow keys and swipes move between loaded photos.
 */
export function Lightbox({
  samples,
  index,
  onIndexChange,
  returnFocus,
  onReachEnd,
  linkSearch = '',
}: LightboxProps) {
  const sample = index === null ? undefined : samples[index];
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const hasPrevious = index !== null && index > 0;
  const hasNext = index !== null && index < samples.length - 1;

  const go = (delta: -1 | 1) => {
    if (index === null) return;
    const next = index + delta;
    if (next >= 0 && next < samples.length) onIndexChange(next);
    if (delta === 1 && next >= samples.length - 2) onReachEnd?.();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') swipeStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const navButton =
    'inline-flex size-11 items-center justify-center rounded-full bg-surface/90 text-ink shadow-lg disabled:opacity-30 hover:bg-surface';

  return (
    <Dialog.Root
      open={sample !== undefined}
      onOpenChange={(open) => {
        if (!open) onIndexChange(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/85" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto focus:outline-none md:inset-4 md:overflow-hidden md:rounded-xl"
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.();
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {sample && (
            <>
              <div className="flex items-center justify-between gap-2 bg-surface px-4 py-2 text-ink">
                <div className="flex min-w-0 items-center gap-2">
                  <Dialog.Title className="text-lg font-semibold tabular">
                    Sample #{sample.id}
                  </Dialog.Title>
                  <StatusBadge ok={sample.ok} />
                  <ConditionsBadge sample={sample} />
                  <span className="sr-only" aria-live="polite">
                    Photo {(index ?? 0) + 1} of {samples.length}
                  </span>
                </div>
                <Dialog.Close className="inline-flex size-11 items-center justify-center rounded-md hover:bg-surface-muted">
                  <IconX />
                  <span className="sr-only">Close</span>
                </Dialog.Close>
              </div>

              <div className="grid min-h-0 flex-1 bg-surface md:grid-cols-[minmax(0,1fr)_20rem]">
                <div
                  className="relative flex min-h-0 touch-pan-y items-center justify-center bg-black"
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                >
                  <SamplePhoto
                    sample={sample}
                    priority
                    size="lg"
                    className="max-h-full bg-black md:aspect-auto md:h-full [&_img]:object-contain"
                  />
                  <div className="pointer-events-none absolute inset-x-2 top-1/2 flex -translate-y-1/2 justify-between">
                    <button
                      type="button"
                      className={`${navButton} pointer-events-auto`}
                      onClick={() => {
                        go(-1);
                      }}
                      disabled={!hasPrevious}
                    >
                      <IconChevronLeft />
                      <span className="sr-only">Previous photo</span>
                    </button>
                    <button
                      type="button"
                      className={`${navButton} pointer-events-auto`}
                      onClick={() => {
                        go(1);
                      }}
                      disabled={!hasNext}
                    >
                      <IconChevronRight />
                      <span className="sr-only">Next photo</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-4 p-4 text-ink">
                  <Dialog.Description className="text-sm text-ink-muted">
                    {formatDateTime(sample.createdAt)} · <RelativeTime value={sample.createdAt} />
                  </Dialog.Description>
                  <ReadingList sample={sample} layout="sidebar" />
                  <div className="flex flex-wrap gap-2">
                    {sample.photoUrl && (
                      <a
                        href={sample.photoUrl}
                        download={`sylvan-sample-${sample.id}.jpg`}
                        className={buttonClass('secondary')}
                      >
                        <IconDownload size={16} />
                        Download
                      </a>
                    )}
                    <Link
                      to={`/samples/${sample.id}${linkSearch}`}
                      className={buttonClass('primary')}
                    >
                      Open details
                    </Link>
                  </div>
                  <p className="hidden text-xs text-ink-muted md:block">
                    Use ← and → to move between photos, Esc to close.
                  </p>
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
