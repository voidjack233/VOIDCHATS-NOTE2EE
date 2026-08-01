import {
  apiJson,
  apiRequest,
  clearCsrfToken,
  ensureCsrfToken,
  publicJson,
  publicRequest,
  refreshSession,
  setLogoutInProgress,
  ApiError,
} from './api';
import type { Session, TwoFactorChallenge, User } from '../types/models';

export interface CaptchaData {
  captchaId: string;
  captchaAnswer: string;
}

export interface AuthResponse {
  success: boolean;
  message?: string;
  code?: string;
  email?: string;
  verificationToken?: string;
  twoFactorToken?: string;
  requires2FA?: boolean;
  methods?: TwoFactorChallenge['methods'];
  defaultMethod?: TwoFactorChallenge['defaultMethod'];
  cooldown?: number;
  retryAfterMs?: number;
  cooldownUntil?: number;
  resetTime?: number;
  codeSent?: boolean;
  user?: User;
  backupCodes?: string[];
  qrCode?: string;
  secret?: string;
}

async function fetchFullUser(): Promise<User | null> {
  const authResponse = await apiRequest('/api/me');
  if (authResponse.status === 401) return null;
  if (!authResponse.ok) {
    throw new ApiError('The account service is unavailable.', { status: authResponse.status });
  }
  const authData = await authResponse.json() as { success?: boolean; user?: User };
  if (!authData.success || !authData.user) {
    throw new ApiError('The account service returned an invalid session response.');
  }

  const accountResponse = await apiRequest('/api/users/account');
  if (accountResponse.status === 401) return null;
  if (!accountResponse.ok) {
    throw new ApiError('The account service is unavailable.', { status: accountResponse.status });
  }
  const accountData = await accountResponse.json() as {
    success?: boolean;
    account?: Partial<User>;
  };
  const user = accountData.success && accountData.account
    ? { ...authData.user, ...accountData.account }
    : authData.user;
  await ensureCsrfToken();
  return user;
}

export const authService = {
  async startup(): Promise<{
    status: 'authenticated' | 'unauthenticated' | 'unavailable';
    user: User | null;
  }> {
    const refreshed = await refreshSession();
    if (refreshed === 'invalid') return { status: 'unauthenticated', user: null };
    if (refreshed === 'unavailable') return { status: 'unavailable', user: null };

    try {
      const user = await fetchFullUser();
      if (!user) return { status: 'unauthenticated', user: null };
      return { status: 'authenticated', user };
    } catch {
      return { status: 'unavailable', user: null };
    }
  },

  async currentUser() {
    return fetchFullUser();
  },

  checkCaptchaRequired(action: 'login' | 'register' = 'login') {
    return publicJson<{ captchaRequired: boolean }>(`/api/captcha/check?action=${action}`)
      .catch(() => ({ captchaRequired: true }));
  },

  generateCaptcha() {
    return publicJson<{ success: true; image: string; captchaId: string }>('/api/captcha/generate');
  },

  async login(credentials: { identifier: string; password: string } & Partial<CaptchaData>) {
    const data = await publicJson<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    if (!data.twoFactorToken && !data.requires2FA) {
      clearCsrfToken();
      await ensureCsrfToken();
    }
    return data;
  },

  register(data: { username: string; email: string; password: string } & Partial<CaptchaData>) {
    return publicJson<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  validateVerificationToken(token: string) {
    return publicJson<AuthResponse>('/api/auth/validate-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  sendVerificationCode(token: string, captcha: CaptchaData) {
    return publicJson<AuthResponse>('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ token, ...captcha }),
    });
  },

  verifyEmail(token: string, code: string) {
    return publicJson<AuthResponse>('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token, code }),
    });
  },

  resendVerification(email: string, captcha: CaptchaData) {
    return publicJson<AuthResponse>('/api/auth/resend-email-code', {
      method: 'POST',
      body: JSON.stringify({ email, ...captcha }),
    });
  },

  forgotPassword(email: string, captcha: CaptchaData) {
    return publicJson<AuthResponse>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email, ...captcha }),
    });
  },

  checkResetToken(token: string) {
    return publicJson<AuthResponse>('/api/auth/check-reset-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  resetPassword(token: string, newPassword: string) {
    return publicJson<AuthResponse>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    });
  },

  sendLoginEmailCode(twoFactorToken: string) {
    return publicJson<AuthResponse>('/api/auth/2fa/verify-login/send-email', {
      method: 'POST',
      body: JSON.stringify({ twoFactorToken }),
    });
  },

  async verifyLogin2FA(twoFactorToken: string, code: string, method: string) {
    const data = await publicJson<AuthResponse>('/api/auth/2fa/verify-login', {
      method: 'POST',
      body: JSON.stringify({ twoFactorToken, code, method }),
    });
    clearCsrfToken();
    await ensureCsrfToken();
    return data;
  },

  async logout() {
    setLogoutInProgress(true);
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      clearCsrfToken();
      setLogoutInProgress(false);
    }
  },

  changePassword(
    currentPassword: string,
    newPassword: string,
    twoFactor?: { method: string; code: string } | null,
  ) {
    return apiJson<AuthResponse>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword,
        newPassword,
        twoFactorMethod: twoFactor?.method || null,
        twoFactorCode: twoFactor?.code || null,
      }),
    });
  },

  get2FAStatus() {
    return apiJson<{
      success: true;
      twoFactor: { totp: boolean; email: boolean; backupCodesRemaining: number };
    }>('/api/auth/2fa/status');
  },

  setupTOTP(password: string) {
    return apiJson<AuthResponse>('/api/auth/2fa/setup-totp', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  setupEmail2FA(password: string) {
    return apiJson<AuthResponse>('/api/auth/2fa/setup-email', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  verifySetup2FA(method: string, code: string) {
    return apiJson<AuthResponse>('/api/auth/2fa/verify-setup', {
      method: 'POST',
      body: JSON.stringify({ method, code }),
    });
  },

  disable2FA(method: string, password: string) {
    return apiJson<AuthResponse>('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ method, password }),
    });
  },

  regenerateBackupCodes(password: string) {
    return apiJson<AuthResponse>('/api/auth/2fa/backup-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  sendActionEmailCode() {
    return apiJson<AuthResponse>('/api/auth/2fa/send-action-email', {
      method: 'POST',
      body: JSON.stringify({ action: 'change_password' }),
    });
  },

  async sessions() {
    const data = await apiJson<{ success: true; sessions: Session[] }>('/api/users/sessions');
    return data.sessions || [];
  },

  revokeSession(sessionId: string) {
    return apiJson<{ success: true }>(`/api/users/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  },

  revokeAllSessions() {
    return apiJson<{ success: true }>('/api/users/sessions', { method: 'DELETE' });
  },
};

export function asTwoFactorChallenge(response: AuthResponse): TwoFactorChallenge | null {
  if (!response.twoFactorToken) return null;
  const methods: TwoFactorChallenge['methods'] = response.methods?.length ? response.methods : ['totp'];
  const defaultMethod: TwoFactorChallenge['defaultMethod'] = response.defaultMethod && methods.includes(response.defaultMethod)
    ? response.defaultMethod
    : methods[0];
  return {
    twoFactorToken: response.twoFactorToken,
    methods,
    defaultMethod,
  };
}

export async function logoutBestEffort() {
  try {
    await authService.logout();
  } catch {
    // Local auth state is still cleared by the caller.
  }
}

export { publicRequest };
