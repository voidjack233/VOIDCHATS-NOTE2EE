import { API_URL } from '../config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFINITIVE_REFRESH_CODES = new Set([
  'NO_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'DEVICE_MISMATCH',
  'USER_NOT_VERIFIED',
]);

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly payload?: Record<string, unknown>;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    payload?: Record<string, unknown>;
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.payload = options.payload;
  }
}

export class AuthUnavailableError extends ApiError {
  constructor() {
    super('The server is unavailable. Your session will be retried.', {
      code: 'AUTH_SESSION_UNAVAILABLE',
    });
    this.name = 'AuthUnavailableError';
  }
}

let csrfToken: string | null = null;
let csrfPromise: Promise<string | null> | null = null;
let refreshPromise: Promise<'ok' | 'invalid' | 'unavailable'> | null = null;
let logoutInProgress = false;
const sessionInvalidationHandlers = new Set<() => void>();

const notifySessionInvalidated = () => {
  sessionInvalidationHandlers.forEach((handler) => handler());
};

export function onSessionInvalidated(handler: () => void) {
  sessionInvalidationHandlers.add(handler);
  return () => {
    sessionInvalidationHandlers.delete(handler);
  };
}

const fullUrl = (path: string) => path.startsWith('http') ? path : `${API_URL}${path}`;

async function jsonSafely(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.clone().json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function publicRequest(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(fullUrl(path), {
    ...options,
    headers,
    credentials: 'include',
  });
}

export async function publicJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await publicRequest(path, options);
  const payload = await jsonSafely(response);
  if (!response.ok || payload.success === false) {
    throw new ApiError(
      String(payload.message || payload.error || payload.code || 'Request failed'),
      { status: response.status, code: String(payload.code || ''), payload },
    );
  }
  return payload as T;
}

export function clearCsrfToken() {
  csrfToken = null;
  csrfPromise = null;
}

export async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  if (csrfPromise) return csrfPromise;
  csrfPromise = (async () => {
    try {
      const response = await publicRequest('/api/csrf/csrf-token');
      const payload = await jsonSafely(response);
      csrfToken = response.ok && payload.success && typeof payload.csrfToken === 'string'
        ? payload.csrfToken
        : null;
      return csrfToken;
    } finally {
      csrfPromise = null;
    }
  })();
  return csrfPromise;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function refreshSession(): Promise<'ok' | 'invalid' | 'unavailable'> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await publicRequest('/api/auth/refresh', {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          clearCsrfToken();
          return 'ok';
        }
        const payload = await jsonSafely(response);
        const code = typeof payload.code === 'string' ? payload.code : '';
        if (code && DEFINITIVE_REFRESH_CODES.has(code)) {
          notifySessionInvalidated();
          return 'invalid';
        }
        if (![500, 502, 503, 504].includes(response.status)) return 'unavailable';
      } catch {
        clearTimeout(timeout);
      }
      if (attempt < 4) await wait(Math.min(250 * (2 ** attempt), 2_000));
    }
    return 'unavailable';
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function looksLikeCsrfFailure(response: Response) {
  if (![400, 403, 419].includes(response.status)) return false;
  const payload = await jsonSafely(response);
  return /csrf|xsrf|forgery|token validation failed/i.test(JSON.stringify(payload));
}

export async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  const mutation = !SAFE_METHODS.has(method);
  const headers = new Headers(options.headers);
  const bodyIsBinary = options.body instanceof Blob || options.body instanceof FormData;
  if (options.body && !bodyIsBinary && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (mutation) {
    const token = await ensureCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }

  const perform = () => publicRequest(path, { ...options, headers });
  let response = await perform();

  if (response.status === 401 && !logoutInProgress) {
    const refreshResult = await refreshSession();
    if (refreshResult === 'unavailable') throw new AuthUnavailableError();
    if (refreshResult === 'ok') {
      if (mutation) {
        const token = await ensureCsrfToken();
        if (token) headers.set('X-CSRF-Token', token);
      }
      response = await perform();
    }
  }

  if (mutation && (response.status === 403 || await looksLikeCsrfFailure(response))) {
    clearCsrfToken();
    const token = await ensureCsrfToken();
    if (token) {
      headers.set('X-CSRF-Token', token);
      response = await perform();
    }
  }
  return response;
}

export async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiRequest(path, options);
  const payload = await jsonSafely(response);
  if (!response.ok || payload.success === false) {
    throw new ApiError(
      String(payload.message || payload.error || payload.code || 'Request failed'),
      { status: response.status, code: String(payload.code || ''), payload },
    );
  }
  return payload as T;
}

export function setLogoutInProgress(value: boolean) {
  logoutInProgress = value;
}

export function toApiError(error: unknown, fallback = 'Request failed') {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError(error.message || fallback);
  return new ApiError(fallback);
}
