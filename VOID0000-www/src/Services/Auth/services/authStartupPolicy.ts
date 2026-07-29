import type { User } from '../types';

export const canStartAuthenticatedProviders = ({
  loading,
  authUnavailable,
  user,
}: {
  loading: boolean;
  authUnavailable: boolean;
  user: User | null;
}): boolean => (
  !loading &&
  !authUnavailable &&
  Boolean(user?.id)
);
