export type PresenceActivityStatus = 'online' | 'idle';
export type PresenceMode = 'online' | 'idle' | 'dnd' | 'invisible';
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface PresenceModeOption {
  mode: PresenceMode;
  label: string;
  description: string;
  publicStatus: PresenceStatus | null;
}
export const PRESENCE_MODE_OPTIONS: readonly PresenceModeOption[] = [
  {
    mode: 'online',
    label: 'Online',
    description: 'Automatically becomes idle when inactive',
    publicStatus: null,
  },
  {
    mode: 'idle',
    label: 'Idle',
    description: 'Appear away while connected',
    publicStatus: 'idle',
  },
  {
    mode: 'dnd',
    label: 'Do Not Disturb',
    description: 'Appear unavailable while connected',
    publicStatus: 'dnd',
  },
  {
    mode: 'invisible',
    label: 'Invisible',
    description: 'Appear offline while staying connected',
    publicStatus: 'offline',
  },
] as const;

const PRESENCE_MODES = new Set<PresenceMode>(
  PRESENCE_MODE_OPTIONS.map(({ mode }) => mode),
);

export function isPresenceMode(value: unknown): value is PresenceMode {
  return typeof value === 'string' && PRESENCE_MODES.has(value as PresenceMode);
}

export function normalizePresenceMode(value: unknown): PresenceMode {
  if (value === 'auto') return 'online';
  return isPresenceMode(value) ? value : 'online';
}

export function resolveOwnPresenceStatus(
  mode: PresenceMode,
  activityStatus: PresenceActivityStatus,
): PresenceStatus {
  if (mode === 'online') return activityStatus;
  if (mode === 'idle') return 'idle';
  if (mode === 'dnd') return 'dnd';
  return 'offline';
}

export function getPresenceModeLabel(mode: PresenceMode): string {
  return PRESENCE_MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? 'Online';
}

export function getPresenceStatusLabel(status: PresenceStatus): string {
  if (status === 'online') return 'Online';
  if (status === 'idle') return 'Idle';
  if (status === 'dnd') return 'Do Not Disturb';
  return 'Offline';
}
