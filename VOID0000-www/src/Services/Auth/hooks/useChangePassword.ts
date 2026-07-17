import { useState } from 'react';
import { authService } from '../services/authService';

export function useChangePassword() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const changePassword = async (
    currentPassword: string,
    newPassword: string,
    twoFactor?: { method: string; code: string } | null,
  ) => {
    setIsLoading(true);
    setError('');
    setSuccess(false);

    try {
      const result = await authService.changePassword(
        currentPassword,
        newPassword,
        twoFactor || null,
      );

      if (!result.success) {
        setError(result.message || 'Failed to change password');
        return false;
      }

      setSuccess(true);
      return true;
    } catch {
      setError('Something went wrong. Please try again.');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const reset = () => {
    setError('');
    setSuccess(false);
  };

  return {
    isLoading,
    error,
    success,
    changePassword,
    reset,
  };
}
