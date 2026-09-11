export async function syncLiveTokenExpiry(
  userId: string | null | undefined,
  deviceId: string | null | undefined,
  newExp: number,
  sessionId: string,
): Promise<void> {
  if (!userId || !deviceId || !Number.isInteger(newExp)) return;

  const { publishGatewayCommand } = await import('../valkey-pubsub.js');
  publishGatewayCommand('updateTokenExpiry', { userId, deviceId, newExp, sessionId });
}
