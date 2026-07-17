import { useUser } from '../context/UserContext';
import type { User } from '../types';

export const useAuth = (): { user: User | null; loading: boolean } => {
  const { user, loading } = useUser();
  return { user, loading };
};
