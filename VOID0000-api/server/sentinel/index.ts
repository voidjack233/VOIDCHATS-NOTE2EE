const DEFAULT_MAX_ACTIVE_FLIGHTS = 5_000;

interface SentinelOptions {
  maxActiveFlights?: number;
}

interface SentinelStats {
  started: number;
  joined: number;
  succeeded: number;
  failed: number;
  bypassed: number;
}

export interface SentinelSnapshot extends SentinelStats {
  enabled: boolean;
  active: number;
  maxActive: number;
}

function parseMaxActiveFlights(value: unknown): number {
  const normalized = value == null ? '' : String(value).trim();
  if (normalized === '') {
    return DEFAULT_MAX_ACTIVE_FLIGHTS;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_ACTIVE_FLIGHTS;
}

function encodeKeyPart(value: unknown): string {
  if (value === null) {
    return '4:null0:';
  }

  const valueType = typeof value;
  if (!['string', 'number', 'boolean', 'undefined'].includes(valueType)) {
    throw new TypeError('Sentinel key dimensions must be scalar values');
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Sentinel key numbers must be finite');
  }

  const serialized = valueType === 'undefined' ? '' : String(value);
  return `${valueType.length}:${valueType}${serialized.length}:${serialized}`;
}

export function createSentinelKey(namespace: unknown, ...dimensions: unknown[]): string {
  if (typeof namespace !== 'string' || namespace.trim().length === 0) {
    throw new TypeError('Sentinel key namespace must be a non-empty string');
  }

  return [namespace.trim(), ...dimensions]
    .map(encodeKeyPart)
    .join('|');
}

export class Sentinel {
  readonly maxActiveFlights: number;
  private readonly flights: Map<string, Promise<unknown>>;
  private readonly stats: SentinelStats;

  constructor({ maxActiveFlights = DEFAULT_MAX_ACTIVE_FLIGHTS }: SentinelOptions = {}) {
    if (!Number.isSafeInteger(maxActiveFlights) || maxActiveFlights < 0) {
      throw new TypeError('maxActiveFlights must be a non-negative safe integer');
    }

    this.maxActiveFlights = maxActiveFlights;
    this.flights = new Map();
    this.stats = {
      started: 0,
      joined: 0,
      succeeded: 0,
      failed: 0,
      bypassed: 0,
    };
  }

  guard<Result>(
    key: string,
    fetchFn: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('Sentinel guard key must be a non-empty string');
    }
    if (typeof fetchFn !== 'function') {
      throw new TypeError('Sentinel guard fetchFn must be a function');
    }

    const activeFlight = this.flights.get(key);
    if (activeFlight) {
      this.stats.joined += 1;
      // A Sentinel key identifies one operation contract for its lifetime.
      return activeFlight as Promise<Result>;
    }

    if (this.flights.size >= this.maxActiveFlights) {
      this.stats.bypassed += 1;
      return Promise.resolve().then(fetchFn);
    }

    // Defer execution to a microtask so the flight is registered before fetchFn runs.
    const currentFlight: Promise<Result> = Promise.resolve().then(fetchFn);
    this.flights.set(key, currentFlight);
    this.stats.started += 1;

    void currentFlight.then(
      () => {
        this.stats.succeeded += 1;
        this.release(key, currentFlight);
      },
      () => {
        this.stats.failed += 1;
        this.release(key, currentFlight);
      },
    );

    return currentFlight;
  }

  release(key: string, flight: Promise<unknown>): void {
    if (this.flights.get(key) === flight) {
      this.flights.delete(key);
    }
  }

  getSnapshot(): SentinelSnapshot {
    return {
      enabled: this.maxActiveFlights > 0,
      active: this.flights.size,
      maxActive: this.maxActiveFlights,
      ...this.stats,
    };
  }

  get isEnabled(): boolean {
    return this.maxActiveFlights > 0;
  }
}

const sentinel = new Sentinel({
  maxActiveFlights: parseMaxActiveFlights(process.env.SENTINEL_MAX_ACTIVE_FLIGHTS),
});

export default sentinel;
