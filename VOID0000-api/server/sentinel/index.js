const DEFAULT_MAX_ACTIVE_FLIGHTS = 5_000;

function parseMaxActiveFlights(value) {
  const normalized = value == null ? '' : String(value).trim();
  if (normalized === '') {
    return DEFAULT_MAX_ACTIVE_FLIGHTS;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_ACTIVE_FLIGHTS;
}

function encodeKeyPart(value) {
  if (value === null) {
    return '4:null0:';
  }

  const valueType = typeof value;
  if (!['string', 'number', 'boolean', 'undefined'].includes(valueType)) {
    throw new TypeError('Sentinel key dimensions must be scalar values');
  }

  if (valueType === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Sentinel key numbers must be finite');
  }

  const serialized = valueType === 'undefined' ? '' : String(value);
  return `${valueType.length}:${valueType}${serialized.length}:${serialized}`;
}

export function createSentinelKey(namespace, ...dimensions) {
  if (typeof namespace !== 'string' || namespace.trim().length === 0) {
    throw new TypeError('Sentinel key namespace must be a non-empty string');
  }

  return [namespace.trim(), ...dimensions]
    .map(encodeKeyPart)
    .join('|');
}

export class Sentinel {
  constructor({ maxActiveFlights = DEFAULT_MAX_ACTIVE_FLIGHTS } = {}) {
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

  guard(key, fetchFn) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('Sentinel guard key must be a non-empty string');
    }
    if (typeof fetchFn !== 'function') {
      throw new TypeError('Sentinel guard fetchFn must be a function');
    }

    const activeFlight = this.flights.get(key);
    if (activeFlight) {
      this.stats.joined += 1;
      return activeFlight;
    }

    if (this.flights.size >= this.maxActiveFlights) {
      this.stats.bypassed += 1;
      return Promise.resolve().then(fetchFn);
    }

    // Defer execution to a microtask so the flight is registered before fetchFn runs.
    const currentFlight = Promise.resolve().then(fetchFn);
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

  release(key, flight) {
    if (this.flights.get(key) === flight) {
      this.flights.delete(key);
    }
  }

  getSnapshot() {
    return {
      enabled: this.maxActiveFlights > 0,
      active: this.flights.size,
      maxActive: this.maxActiveFlights,
      ...this.stats,
    };
  }

  get isEnabled() {
    return this.maxActiveFlights > 0;
  }
}

const sentinel = new Sentinel({
  maxActiveFlights: parseMaxActiveFlights(process.env.SENTINEL_MAX_ACTIVE_FLIGHTS),
});

export default sentinel;
