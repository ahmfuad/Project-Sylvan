import { createBrowserRouter, useRouteError } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { Skeleton } from './components/ui/Skeleton';
import { ErrorState } from './components/ui/States';

function RouteError() {
  const error = useRouteError();
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="sr-only">Error</h1>
      <ErrorState
        error={error}
        title="This page failed to load"
        onRetry={() => {
          window.location.reload();
        }}
      />
    </main>
  );
}

function PageFallback() {
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6" aria-hidden="true">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64" />
    </div>
  );
}

const page = (load: () => Promise<{ default: React.ComponentType }>) => async () => ({
  Component: (await load()).default,
});

// Each page is its own chunk, so the Overview does not download Gallery or Data code.
export const routes = [
  {
    path: '/',
    Component: AppLayout,
    ErrorBoundary: RouteError,
    HydrateFallback: PageFallback,
    children: [
      { index: true, lazy: page(() => import('./pages/overview/OverviewPage')) },
      { path: 'gallery', lazy: page(() => import('./pages/GalleryPage')) },
      { path: 'live', lazy: page(() => import('./pages/LivePage')) },
      { path: 'explore', lazy: page(() => import('./pages/explore/ExplorePage')) },
      { path: 'data', lazy: page(() => import('./pages/DataPage')) },
      { path: 'debug', lazy: page(() => import('./pages/DebugPage')) },
      { path: 'samples/:id', lazy: page(() => import('./pages/SampleDetailPage')) },
      { path: '*', lazy: page(() => import('./pages/NotFoundPage')) },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
