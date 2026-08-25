export async function syncLiveTokenExpiry(
  userId: string | null | undefined,
  deviceId: string | null | undefined,
  newExp: number,
): Promise<void> {
  if (!userId || !deviceId || !Number.isInteger(newExp)) return;

  const { publishGatewayCommand } = await import('../valkey-pubsub.js');
  publishGatewayCommand('updateTokenExpiry', { userId, deviceId, newExp });
}

export async function disconnectLiveSession(
  userId: string | null | undefined,
  deviceId: string | null | undefined,
  code: number = 4001,
  reason: string = 'Session revoked',
): Promise<void> {
  if (!userId) return;

  const { publishGatewayCommand } = await import('../valkey-pubsub.js');
  publishGatewayCommand('disconnectSession', { userId, deviceId, code, reason });
}
