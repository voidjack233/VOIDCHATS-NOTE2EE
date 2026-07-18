import { API_URL } from '../../config';
import {
  clearCSRFToken,
  ensureCSRFToken,
  fetchWithAuth,
  getRetryAfterMs,
  isAuthSessionUnavailableError,
  markAuthSessionEstablished,
  refreshAuthSession,
  requestCSRFToken,
  setAuthLogoutInProgress,
} from '../client/authClient';
import type {
  ApiResponse,
  AuthVerificationResult,
  CaptchaData,
  User,
} from '../types';

export const authService = {
  async checkAuthStatus(): Promise<boolean> {
    try {
      const response = await fetchWithAuth('/api/me');
      return response.ok;
    } catch {
      return false;
    }
  },

  async getCurrentUser(): Promise<User | null> {
    try {
      const response = await fetchWithAuth('/api/me');
      if (!response.ok) return null;

      const data = await response.json();

      if (data.user) {
        await ensureCSRFToken();
      }

      return data.user ?? null;
    } catch {
      return null;
    }
  },

  async verifyAuthWithRefresh(): Promise<AuthVerificationResult> {
    try {
      const response = await fetchWithAuth('/api/me');
      if (!response.ok) {
        return { authenticated: false, user: null };
      }

      const data = await response.json();

      if (data.user) {
        await ensureCSRFToken();
      }

      return { authenticated: true, user: data.user ?? null };
    } catch (error) {
      if (isAuthSessionUnavailableError(error)) {
        return { authenticated: false, user: null, networkError: true };
      }
      return { authenticated: false, user: null, networkError: true };
    }
  },

  async checkCaptchaRequired(action = 'login'): Promise<{ captchaRequired: boolean }> {
    try {
      const response = await fetch(`${API_URL}/api/captcha/check?action=${action}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return { captchaRequired: data.captchaRequired ?? true };
    } catch {
      return { captchaRequired: true };
    }
  },

  async login(
    credentials: { identifier: string; password: string } & Partial<CaptchaData>,
  ): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        const payload = data && typeof data === 'object'
          ? data as Record<string, unknown>
          : {};
        const retryAfterMs = getRetryAfterMs(response, payload);
        const cooldownUntil = Number(payload.cooldownUntil);
        throw {
          ...payload,
          retryAfterMs: retryAfterMs ?? undefined,
          cooldownUntil: Number.isFinite(cooldownUntil) && cooldownUntil > 0
            ? cooldownUntil
            : retryAfterMs
              ? Date.now() + retryAfterMs
              : undefined,
        };
      }
      throw data;
    }

    const requiresTwoFactor = Boolean(data?.requires2FA || data?.twoFactorToken);
    if (!requiresTwoFactor) {
      markAuthSessionEstablished();
      await requestCSRFToken();
    }
    return data;
  },

  async logout(): Promise<void> {
    setAuthLogoutInProgress(true);

    try {
      const token = await ensureCSRFToken();

      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'X-CSRF-Token': token }),
        },
      });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      clearCSRFToken();
      localStorage.clear();
      sessionStorage.clear();
      setAuthLogoutInProgress(false);
    }
  },

  async refreshToken(): Promise<boolean> {
    const result = await refreshAuthSession();
    return result.success;
  },

  async register(
    userData: { username: string; email: string; password: string } & Partial<CaptchaData>,
  ): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
      credentials: 'include',
    });
    return await response.json();
  },

  async validateToken(vtoken: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/validate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vtoken }),
      credentials: 'include',
    });
    return await response.json();
  },

  async sendVerificationCode(vtoken: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vtoken, ...captcha }),
      credentials: 'include',
    });
    return await response.json();
  },

  async verifyEmail(code: string, vtoken: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, token: vtoken }),
      credentials: 'include',
    });
    return await response.json();
  },

  async resendVerification(email: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/resend-email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...captcha }),
      credentials: 'include',
    });
    return response.json();
  },

  async forgotPassword(email: string, captcha?: CaptchaData): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...captcha }),
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok) {
      throw data;
    }

    return data;
  },

  async resetPassword(token: string, newPassword: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
      credentials: 'include',
    });
    return await response.json();
  },

  async checkResetToken(token: string): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/check-reset-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'include',
    });
    return await response.json();
  },

  async changePassword(
    currentPassword: string,
    newPassword: string,
    twoFactor?: {
      method: string;
      code: string;
    } | null,
  ): Promise<ApiResponse> {
    const response = await fetchWithAuth('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword,
        newPassword,
        twoFactorMethod: twoFactor?.method || null,
        twoFactorCode: twoFactor?.code || null,
      }),
    });
    const result = await response.json();

    if (result.success) {
      clearCSRFToken();
      await requestCSRFToken();
    }

    return result;
  },

  async get2FAStatus(): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/status');
    return response.json();
  },

  async setupTOTP(password: string): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/setup-totp', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return response.json();
  },

  async setupEmail2FA(password: string): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/setup-email', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return response.json();
  },

  async verifySetup2FA(method: string, code: string): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/verify-setup', {
      method: 'POST',
      body: JSON.stringify({ method, code }),
    });
    return response.json();
  },

  async verify2FALogin(
    twoFactorToken: string,
    code: string,
    method: string,
  ): Promise<ApiResponse> {
    const response = await fetch(`${API_URL}/api/auth/2fa/verify-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twoFactorToken, code, method }),
      credentials: 'include',
    });
    const data = await response.json();
    if (!response.ok) throw data;
    markAuthSessionEstablished();
    await requestCSRFToken();
    return data;
  },

  async send2FAEmailCode(twoFactorToken: string): Promise<any> {
    const response = await fetch(`${API_URL}/api/auth/2fa/verify-login/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twoFactorToken }),
      credentials: 'include',
    });
    return response.json();
  },

  async sendAuthenticated2FAEmailCode(action: 'change_password'): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/send-action-email', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    return response.json();
  },

  async disable2FA(method: string, password: string): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ method, password }),
    });
    return response.json();
  },

  async regenerateBackupCodes(password: string): Promise<any> {
    const response = await fetchWithAuth('/api/auth/2fa/backup-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return response.json();
  },
};

export type AuthService = typeof authService;
