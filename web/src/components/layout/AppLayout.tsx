import { useEffect, useRef } from 'react';
import { Link, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useLiveUpdates } from '../../lib/live';
import { useFilters } from '../../lib/useFilters';
import { useOnline } from '../../lib/useOnline';
import { IconLeaf, IconWifiOff } from '../ui/Icons';
import { LastUpload } from './LastUpload';
import { BottomNav, TopNav } from './Navigation';
import { RangeControl } from './RangeControl';
import { ThemeToggle } from './ThemeToggle';
import { ToastProvider, useToasts } from './Toasts';

function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="border-b border-border bg-warn-soft">
      <p className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm text-ink sm:px-6">
        <IconWifiOff size={16} />
        You are offline. Showing the last loaded data; it will refresh when you reconnect.
      </p>
    </div>
  );
}

/** Moves focus to the page heading after client-side navigation, for screen reader users. */
function useRouteFocus() {
  const { pathname } = useLocation();
  // Track the previous path rather than a "first render" flag, which StrictMode's double effects defeat.
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [pathname]);
}

function AppShell() {
  const { showToast } = useToasts();
  const { linkSearch } = useFilters();
  const latest = useLiveUpdates((sample) => {
    showToast({
      message: `New sample #${sample.id}`,
      link: { to: `/samples/${sample.id}${linkSearch}`, label: 'View' },
    });
  });
  useRouteFocus();

  return (
    <div className="min-h-dvh pb-20 md:pb-0">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-brand px-4 py-2 text-brand-contrast focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Link
            to={{ pathname: '/', search: linkSearch }}
            className="flex min-h-11 items-center gap-2 rounded-md text-lg font-semibold tracking-tight text-ink"
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-brand text-brand-contrast">
              <IconLeaf size={18} />
            </span>
            Sylvan
          </Link>
          <TopNav />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div className="hidden lg:block">
              <LastUpload latest={latest} />
            </div>
            <RangeControl />
            <ThemeToggle />
          </div>
          <div className="w-full pb-1 lg:hidden">
            <LastUpload latest={latest} />
          </div>
        </div>
      </header>
      <OfflineBanner />
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-ink-muted sm:px-6">
        Sylvan {__APP_VERSION__}
      </footer>
      <BottomNav />
      <ScrollRestoration />
    </div>
  );
}

/** The layout route. Toasts live inside the router because they render links. */
export function AppLayout() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
