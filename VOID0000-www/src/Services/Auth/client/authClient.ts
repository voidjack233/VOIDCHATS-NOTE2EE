import { API_URL } from '../../config';
import type { RefreshResult } from '../types';

let csrfToken: string | null = null;
let isLoggingOut = false;
let refreshPromise: Promise<RefreshResult> | null = null;
let sessionInvalidationDispatched = false;

export const AUTH_SESSION_INVALIDATED_EVENT = 'void:auth-session-invalidated';

const DEFINITIVE_REFRESH_FAILURE_CODES = new Set([
  'NO_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'DEVICE_MISMATCH',
  'USER_NOT_VERIFIED',
]);
const REFRESH_MAX_RETRIES = 4;
const REFRESH_RETRY_MAX_MS = 2_000;
const REFRESH_REQUEST_TIMEOUT_MS = 8_000;
const TRANSIENT_REFRESH_STATUSES = new Set([500, 502, 503, 504]);
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_ERROR_PATTERN = /\b(csrf|xsrf|forgery)\b|token validation failed/i;

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

async function waitBeforeRefreshRetry(milliseconds: number): Promise<void> {
  if (navigator.onLine) {
    await wait(milliseconds);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('online', finish);
      window.clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, Math.max(milliseconds, 2_000));
    window.addEventListener('online', finish, { once: true });
  });
}

async function requestRefresh(refreshUrl: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, REFRESH_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(refreshUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export class AuthSessionUnavailableError extends Error {
  readonly code = 'AUTH_SESSION_UNAVAILABLE';

  constructor(message = 'The server is unavailable. Your session will be retried.') {
    super(message);
    this.name = 'AuthSessionUnavailableError';
  }
}

export function isAuthSessionUnavailableError(error: unknown): error is AuthSessionUnavailableError {
  return error instanceof AuthSessionUnavailableError ||
    (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'AUTH_SESSION_UNAVAILABLE'
    );
}

async function readJsonSafely(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.clone().json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getRetryAfterMs(
  response: Response,
  payload: Record<string, unknown>,
): number | null {
  const retryAfterMs = Number(payload.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }

  const cooldownUntil = Number(payload.cooldownUntil);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return cooldownUntil - Date.now();
  }

  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfter);
  return Number.isFinite(retryAfterDate)
    ? Math.max(0, retryAfterDate - Date.now())
    : null;
}

function isMutationMethod(method?: string): boolean {
  if (!method) return false;
  return !SAFE_HTTP_METHODS.has(method.toUpperCase());
}

function containsCSRFSignal(value: unknown): boolean {
  if (typeof value === 'string') {
    return CSRF_ERROR_PATTERN.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(containsCSRFSignal);
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsCSRFSignal);
  }

  return false;
}

async function isLikelyCSRFError(response: Response): Promise<boolean> {
  if (![400, 403, 419].includes(response.status)) {
    return false;
  }

  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = await response.clone().json();
      return containsCSRFSignal(payload);
    }

    const textPayload = await response.clone().text();
    return containsCSRFSignal(textPayload);
  } catch {
    return false;
  }
}

export async function requestCSRFToken(): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/api/csrf/csrf-token`, {
      method: 'GET',
      credentials: 'include',
    });
    const data = await response.json();

    if (data.success && data.csrfToken) {
      csrfToken = data.csrfToken;
      return csrfToken;
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch CSRF token:', error);
    return null;
  }
}

export async function ensureCSRFToken(): Promise<string | null> {
  if (!csrfToken) {
    return await requestCSRFToken();
  }
  return csrfToken;
}

export function clearCSRFToken(): void {
  csrfToken = null;
}

export function setAuthLogoutInProgress(value: boolean): void {
  isLoggingOut = value;
}

export function markAuthSessionEstablished(): void {
  sessionInvalidationDispatched = false;
}

function notifyAuthSessionInvalidated(result: RefreshResult): void {
  if (sessionInvalidationDispatched) {
    return;
  }

  sessionInvalidationDispatched = true;
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_INVALIDATED_EVENT, {
    detail: {
      code: result.code,
      status: result.status,
    },
  }));
}

export async function refreshAuthSession(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshUrl = `${API_URL}/api/auth/refresh`;

    try {
      for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt += 1) {
        let response: Response;

        try {
          response = await requestRefresh(refreshUrl);
        } catch {
          if (attempt < REFRESH_MAX_RETRIES) {
            await waitBeforeRefreshRetry(Math.min(
              250 * (2 ** attempt),
              REFRESH_RETRY_MAX_MS,
            ));
            continue;
          }

          return {
            success: false,
            failureKind: 'unavailable',
          };
        }

        if (response.ok) {
          markAuthSessionEstablished();
          return { success: true, status: response.status };
        }

        const payload = await readJsonSafely(response);
        const code = typeof payload.code === 'string' ? payload.code : undefined;
        const shouldRetry = TRANSIENT_REFRESH_STATUSES.has(response.status);

        if (shouldRetry && attempt < REFRESH_MAX_RETRIES) {
          const retryAfterMs = getRetryAfterMs(response, payload) ?? 250;
          await waitBeforeRefreshRetry(Math.min(
            retryAfterMs * (2 ** attempt),
            REFRESH_RETRY_MAX_MS,
          ));
          continue;
        }

        const result: RefreshResult = {
          success: false,
          failureKind: code && DEFINITIVE_REFRESH_FAILURE_CODES.has(code)
            ? 'invalid'
            : 'unavailable',
          code,
          status: response.status,
        };
        if (result.failureKind === 'invalid') {
          notifyAuthSessionInvalidated(result);
        }
        return result;
      }

      return {
        success: false,
        failureKind: 'unavailable',
      };
    } catch {
      return {
        success: false,
        failureKind: 'unavailable',
      };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
  const method = options.method?.toUpperCase() || 'GET';
  const needsCSRFToken = isMutationMethod(method);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (needsCSRFToken) {
    const token = await ensureCSRFToken();
    if (token) {
      headers['X-CSRF-Token'] = token;
    }
  }

  const performRequest = () => fetch(fullUrl, {
    ...options,
    credentials: 'include',
    headers,
  });

  let response = await performRequest();

  if (response.status === 401 && !isLoggingOut) {
    const refreshResult = await refreshAuthSession();

    if (refreshResult.success) {
      clearCSRFToken();
      const newCsrfToken = await requestCSRFToken();
      if (newCsrfToken && needsCSRFToken) {
        headers['X-CSRF-Token'] = newCsrfToken;
      }

      response = await performRequest();
    } else if (refreshResult.failureKind === 'unavailable') {
      throw new AuthSessionUnavailableError();
    } else {
      return response;
    }
  }

  // Some backends rotate CSRF secrets during membership/session transitions.
  // If we detect CSRF validation, or any mutation returns 403, refresh once.
  if (needsCSRFToken && ((await isLikelyCSRFError(response)) || response.status === 403)) {
    clearCSRFToken();
    const newCsrfToken = await requestCSRFToken();
    if (newCsrfToken) {
      headers['X-CSRF-Token'] = newCsrfToken;
      response = await performRequest();
    }
  }

  return response;
}
