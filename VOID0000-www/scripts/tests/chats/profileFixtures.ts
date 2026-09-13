import type { ConversationDetails, Message } from '../../../src/Services/Chat/chatTypes';
import type { Friend } from '../../../src/Services/hooks/Friends/useFriends';

export const friend: Friend = {
  id: 'peer', profile_id: '202', username: 'peer-handle', display_name: 'Old Name',
  avatar_url: '/avatars/old.svg', bio: 'Old bio', friendship_id: 1,
  friends_since: '2026-01-01', member_since: '2026-01-01',
};
export const conversation: ConversationDetails = {
  id: 'dm', public_id: '123', type: 'dm', name: null, owner_id: 'self', icon_filename: null,
  created_at: '2026-01-01', updated_at: '2026-01-01', role: 'member',
  last_read_message_id: null, dm_user_id: 'peer', dm_username: friend.username,
  dm_display_name: 'Old snapshot', dm_avatar_url: '/avatars/deleted.svg', dm_nickname: null,
  member_count: 2, members: [{
    user_id: friend.id, profile_id: friend.profile_id, username: friend.username,
    display_name: 'Old member', avatar_url: '/avatars/old-member.svg',
    role: 'member', joined_at: '2026-01-01', nickname: null,
  }],
};
export const message: Message = {
  conversation_id: 'dm', message_id: 'msg', sender_id: 'peer', content: 'A real message row',
  message_type: 'text', reply_to: null, is_edited: false, edited_at: null,
  is_deleted: false, created_at: '2026-01-01',
};
export const update = {
  user_id: 'peer', profile_id: '202', display_name: 'New Name',
  avatar_url: '/avatars/new.svg', bio: 'New bio',
};
