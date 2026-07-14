export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  [key: string]: any;
}

export interface UserContextType {
  user: User | null;
  loading: boolean;
  authUnavailable: boolean;
  authRetrying: boolean;
  isLoggingOut: boolean;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  verifySession: () => Promise<'authenticated' | 'invalid' | 'unavailable'>;
  retryAuth: () => Promise<void>;
  logout: () => Promise<void>;
}
