import type {
  ApiError as ApiErrorBody,
  DeviceLogsParams,
  DeviceLogsResponse,
  DeviceStatus,
  ExploreResponse,
  ExportParams,
  NeighborsResponse,
  Sample,
  SampleListParams,
  SampleListResponse,
  StatsParams,
  StatsResponse,
} from '@sylvan/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

type QueryValue = string | number | boolean | null | undefined;

/** Builds `?a=1&b=2`, skipping empty values. Returns '' when nothing is set. */
export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' }, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (for example a proxy error page); handled below.
  }

  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message);
    }
    throw new ApiError(
      response.status,
      `HTTP_${response.status}`,
      `The server responded with an error (${response.status}).`,
    );
  }
  if (body === null) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'The server sent an invalid response.');
  }
  return body as T;
}

export const api = {
  samples: (params: SampleListParams, signal?: AbortSignal) =>
    request<SampleListResponse>(`/api/samples${toQueryString({ ...params })}`, signal),

  sample: (id: number, signal?: AbortSignal) => request<Sample>(`/api/samples/${id}`, signal),

  neighbors: (id: number, signal?: AbortSignal) =>
    request<NeighborsResponse>(`/api/samples/${id}/neighbors`, signal),

  stats: (params: StatsParams, signal?: AbortSignal) =>
    request<StatsResponse>(`/api/stats${toQueryString({ ...params })}`, signal),

  device: (signal?: AbortSignal) => request<DeviceStatus>('/api/device', signal),

  deviceLogs: (params: DeviceLogsParams, signal?: AbortSignal) =>
    request<DeviceLogsResponse>(`/api/device/logs${toQueryString({ ...params })}`, signal),

  explore: (params: StatsParams & { bins?: number }, signal?: AbortSignal) =>
    request<ExploreResponse>(`/api/explore${toQueryString({ ...params })}`, signal),
};

export function exportCsvUrl(params: ExportParams): string {
  return `/api/export.csv${toQueryString({ ...params })}`;
}
