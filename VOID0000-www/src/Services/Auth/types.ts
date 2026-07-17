export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  is_verified?: boolean;
  [key: string]: any;
}

export interface CaptchaData {
  captchaId: string;
  captchaAnswer: string;
}

export interface ApiResponse {
  success: boolean;
  message?: string;
  token?: string;
  verificationToken?: string;
  twoFactorToken?: string;
  user?: User;
  csrfToken?: string;
  code?: string;
  resetTime?: number;
  email?: string;
  codeSent?: boolean;
  cooldown?: number;
  attemptsLeft?: number;
  retryAfterMs?: number;
  cooldownUntil?: number;
  retryAfterSeconds?: number;
}

export type RefreshFailureKind = 'invalid' | 'unavailable';

export interface RefreshResult {
  success: boolean;
  failureKind?: RefreshFailureKind;
  code?: string;
  status?: number;
}

export type SessionVerificationStatus = 'authenticated' | 'invalid' | 'unavailable';

export interface AuthVerificationResult {
  authenticated: boolean;
  user: User | null;
  networkError?: boolean;
}

export interface UserContextType {
  user: User | null;
  loading: boolean;
  authUnavailable: boolean;
  authRetrying: boolean;
  isLoggingOut: boolean;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  verifySession: () => Promise<SessionVerificationStatus>;
  retryAuth: () => Promise<void>;
  logout: () => Promise<void>;
}
