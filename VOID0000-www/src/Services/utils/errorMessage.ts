// APIs may reject with a JSON error body rather than an Error instance.
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    if (typeof error.message === 'string' && error.message) return error.message;
  }
  return fallback;
}
