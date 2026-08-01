export function validateAccountPassword(password: string) {
  if (!password) return 'Password is required';
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 128) return 'Password must be 128 characters or fewer';
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) {
    return 'Password must include letters and at least one number or symbol';
  }
  return null;
}
