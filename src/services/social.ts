import type { Friend, FriendRequest, PresenceStatus, Profile } from '../types/models';
import { apiJson } from './api';

export const socialService = {
  async friends() {
    const data = await apiJson<{ success: true; friends: Friend[] }>('/api/friends');
    return data.friends || [];
  },

  removeFriend(friendshipId: number) {
    return apiJson(`/api/friends/${friendshipId}`, { method: 'DELETE' });
  },

  async incomingRequests() {
    const data = await apiJson<{ success: true; requests: FriendRequest[] }>('/api/friends/requests/incoming');
    return data.requests || [];
  },

  async outgoingRequests() {
    const data = await apiJson<{ success: true; requests: FriendRequest[] }>('/api/friends/requests/outgoing');
    return data.requests || [];
  },

  acceptRequest(friendshipId: number) {
    return apiJson(`/api/friends/accept/${friendshipId}`, { method: 'POST' });
  },

  rejectRequest(friendshipId: number) {
    return apiJson(`/api/friends/reject/${friendshipId}`, { method: 'POST' });
  },

  sendRequest(profileId: string) {
    return apiJson<{ success: true; request?: FriendRequest }>(
      `/api/friends/request/${encodeURIComponent(profileId)}`,
      { method: 'POST' },
    );
  },

  cancelRequest(friendshipId: number) {
    return apiJson(`/api/friends/cancel/${friendshipId}`, { method: 'POST' });
  },

  async presence() {
    const data = await apiJson<{
      success: true;
      presences: Array<{ user_id: string; status: PresenceStatus; last_active?: number | null }>;
    }>('/api/friends/presence');
    return data.presences || [];
  },

  async search(query: string) {
    const data = await apiJson<{ success: true; users: Profile[] }>(
      `/api/users/search?q=${encodeURIComponent(query.trim())}`,
    );
    return data.users || [];
  },
};
