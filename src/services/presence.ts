import type { PresenceMode } from '../features/presence/presenceStatus';
import { apiJson } from './api';

export const presenceService = {
  updateMode(mode: PresenceMode) {
    return apiJson<{ success: true; presence_mode: unknown }>(
      '/api/users/preferences/presence',
      {
        method: 'PATCH',
        body: JSON.stringify({ mode }),
      },
    );
  },
};
