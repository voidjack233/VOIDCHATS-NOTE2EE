import type { Profile, User } from '../types/models';
import { apiJson } from './api';

export const userService = {
  async account() {
    const data = await apiJson<{ success: true; account: User & { created_at?: string } }>('/api/users/account');
    return data.account;
  },

  profile(profileId: string) {
    return apiJson<Profile>(`/api/users/${encodeURIComponent(profileId)}`);
  },

  updateProfile(displayName: string, bio: string) {
    return apiJson<Profile>('/api/users/profile', {
      method: 'PUT',
      body: JSON.stringify({ display_name: displayName.trim(), bio }),
    });
  },

  uploadAvatar(dataUrl: string) {
    return apiJson<Profile>('/api/users/profile/avatar', {
      method: 'PUT',
      body: JSON.stringify({ avatar: dataUrl }),
    });
  },

  removeAvatar() {
    return apiJson<Profile>('/api/users/profile/avatar', { method: 'DELETE' });
  },
};
