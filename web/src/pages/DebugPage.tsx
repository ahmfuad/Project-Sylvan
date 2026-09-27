import type { DeviceLog, DeviceLogLevel, DeviceLogSource } from '@sylvan/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/States';
import { api } from '../lib/api';
import { useLiveSocket, useSocketSnapshot } from '../lib/socketContext';

const PAGE_SIZE = 300;
/** Lines kept in the browser; older ones are dropped from view (they stay on the server). */
const MAX_LINES = 3000;

type SourceFilter = 'all' | DeviceLogSource;
type LevelFilter = 'all' | DeviceLogLevel;

const LEVEL_RANK: Record<DeviceLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVEL_STYLE: Record<DeviceLogLevel, string> = {
  debug: 'text-ink-muted',
  info: 'text-ink',
  warn: 'bg-warn-soft text-ink',
  error: 'bg-failed-soft text-failed',
};

const matches = (line: DeviceLog, source: SourceFilter, level: LevelFilter) =>
  (source === 'all' || line.source === source) &&
  (level === 'all' || LEVEL_RANK[line.level] >= LEVEL_RANK[level]);

const clock = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

/** Plain-text export, one line per entry, in the order shown. */
function toText(lines: DeviceLog[]) {
  return lines
    .map(
      (line) =>
        `${line.receivedAt} ${line.source.padEnd(6)} ${line.level.padEnd(5)} ` +
        `boot=${line.bootId ?? '-'} ms=${line.deviceMs ?? '-'} ${line.message}`,
    )
    .join('\n');
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
        className="min-h-11 rounded-md border border-border bg-surface px-2 text-ink"
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function DebugPage() {
  const { status } = useSocketSnapshot();
  const [source, setSource] = useState<SourceFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [visible, setVisible] = useState<DeviceLog[]>([]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([toText(visible)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `sylvan-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <title>Debug · Sylvan</title>
      <div className="mb-4 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Debug trail</h1>
        <p className="text-sm text-ink-muted">
          Every step the ESP32-CAM and the ATmega32 report, live. ATmega lines are relayed by the
          ESP32 over its serial link. Lines logged while the ESP32 was offline arrive when it
          reconnects.{' '}
          <span className="whitespace-nowrap">
            Live updates: {status === 'open' ? 'connected' : 'reconnecting…'}
          </span>
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Select<SourceFilter>
          label="Source"
          value={source}
          onChange={setSource}
          options={[
            ['all', 'All'],
            ['esp32', 'ESP32'],
            ['atmega', 'ATmega32'],
          ]}
        />
        <Select<LevelFilter>
          label="Level"
          value={level}
          onChange={setLevel}
          options={[
            ['all', 'Everything'],
            ['info', 'Info and up'],
            ['warn', 'Warnings and errors'],
            ['error', 'Errors only'],
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Find</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="e.g. DHT, OpenAI, upload"
            className="min-h-11 w-48 rounded-md border border-border bg-surface px-2 text-ink"
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => {
              setFollow(event.target.checked);
            }}
          />
          Follow newest
        </label>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setReloadKey((key) => key + 1);
            }}
          >
            Reload
          </Button>
          <Button onClick={download} disabled={visible.length === 0}>
            Download .txt
          </Button>
        </div>
      </div>

      {/* Remounts (and refetches) whenever a server-side filter changes or Reload is pressed. */}
      <LogView
        key={`${source}|${level}|${String(reloadKey)}`}
        source={source}
        level={level}
        search={search}
        follow={follow}
        onVisible={setVisible}
        onRetry={() => {
          setReloadKey((key) => key + 1);
        }}
      />
    </>
  );
}

function LogView({
  source,
  level,
  search,
  follow,
  onVisible,
  onRetry,
}: {
  source: SourceFilter;
  level: LevelFilter;
  search: string;
  follow: boolean;
  onVisible: (lines: DeviceLog[]) => void;
  onRetry: () => void;
}) {
  const socket = useLiveSocket();
  /** Chronological: oldest first, newest at the bottom like a terminal. */
  const [lines, setLines] = useState<DeviceLog[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .deviceLogs(
        {
          limit: PAGE_SIZE,
          ...(source === 'all' ? {} : { source }),
          ...(level === 'all' ? {} : { level }),
        },
        controller.signal,
      )
      .then(
        (page) => {
          setLines([...page.items].reverse());
          setNextBefore(page.nextBefore);
          setLoading(false);
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          setError(reason);
          setLoading(false);
        },
      );
    return () => {
      controller.abort();
    };
  }, [source, level]);

  // Live lines pushed by the server.
  useEffect(() => {
    if (!socket) return;
    return socket.subscribe((message) => {
      if (message.type !== 'log.appended') return;
      const fresh = message.entries.filter((line) => matches(line, source, level));
      if (fresh.length === 0) return;
      setLines((current) => {
        const known = new Set(current.map((line) => line.id));
        const merged = [...current, ...fresh.filter((line) => !known.has(line.id))];
        return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
      });
    });
  }, [socket, source, level]);

  const loadOlder = async () => {
    if (nextBefore === null) return;
    try {
      const page = await api.deviceLogs({
        limit: PAGE_SIZE,
        before: nextBefore,
        ...(source === 'all' ? {} : { source }),
        ...(level === 'all' ? {} : { level }),
      });
      setLines((current) => [...[...page.items].reverse(), ...current]);
      setNextBefore(page.nextBefore);
    } catch (reason) {
      setError(reason);
    }
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? lines.filter((line) => line.message.toLowerCase().includes(needle)) : lines;
  }, [lines, search]);

  // Keep the newest line in view while following.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [visible, follow]);

  useEffect(() => {
    onVisible(visible);
  }, [visible, onVisible]);

  return (
    <>
      {error !== null && lines.length === 0 ? (
        <ErrorState error={error} title="Could not load the debug trail" onRetry={onRetry} />
      ) : (
        <div
          ref={scroller}
          className="h-[65vh] overflow-auto rounded-lg border border-border bg-surface font-mono text-xs shadow-card"
          aria-label="Debug log lines"
          role="log"
          tabIndex={0}
        >
          {nextBefore !== null && (
            <div className="border-b border-border p-2 text-center">
              <Button size="sm" onClick={() => void loadOlder()}>
                Load older lines
              </Button>
            </div>
          )}
          {loading && lines.length === 0 ? (
            <p className="p-4 text-ink-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="p-4 text-ink-muted">
              No lines yet. They appear here as soon as the ESP32 connects and reports.
            </p>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {visible.map((line, index) => {
                  const previous = visible[index - 1];
                  const newBoot =
                    line.bootId !== null &&
                    previous !== undefined &&
                    previous.bootId !== line.bootId;
                  return <LogRow key={line.id} line={line} newBoot={newBoot} />;
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-ink-muted">
        Showing {visible.length} of {lines.length} loaded lines. The server keeps 14 days.
      </p>
    </>
  );
}

function LogRow({ line, newBoot }: { line: DeviceLog; newBoot: boolean }) {
  return (
    <>
      {newBoot && (
        <tr>
          <td colSpan={4} className="bg-brand-soft px-2 py-1 text-center font-semibold text-ink">
            ESP32 rebooted (boot {line.bootId})
          </td>
        </tr>
      )}
      <tr className={`border-b border-border/60 align-top ${LEVEL_STYLE[line.level]}`}>
        <td className="py-0.5 pr-2 pl-2 whitespace-nowrap text-ink-muted" title={line.receivedAt}>
          {clock(line.receivedAt)}
        </td>
        <td className="py-0.5 pr-2 whitespace-nowrap">
          <span
            className={`rounded px-1 font-semibold ${
              line.source === 'atmega' ? 'bg-surface-muted text-ink' : 'bg-brand-soft text-ink'
            }`}
          >
            {line.source === 'atmega' ? 'AVR' : 'ESP'}
          </span>
        </td>
        <td className="py-0.5 pr-2 whitespace-nowrap uppercase">{line.level}</td>
        <td className="py-0.5 pr-2 break-all whitespace-pre-wrap">{line.message}</td>
      </tr>
    </>
  );
}
