export type { PresenceStatus } from '../features/presence/presenceStatus';
import type { PresenceStatus } from '../features/presence/presenceStatus';

export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  is_verified?: boolean;
}

export interface Profile {
  id: string;
  profile_id?: string;
  avatar_url?: string | null;
  username: string;
  display_name?: string | null;
  bio?: string | null;
  created_at?: string;
}

export interface Friend extends Profile {
  friendship_id: number;
  friends_since: string;
  member_since?: string | null;
  status?: PresenceStatus;
  last_active?: number | null;
}

export interface FriendRequest extends Profile {
  friendship_id: number;
  created_at: string;
}

export type WhoOption = 'everyone' | 'admins' | 'owner';

export interface GroupPermissions {
  admin_can_remove_members: boolean;
  admin_can_approve_join_requests: boolean;
  admin_can_edit_member_nicknames: boolean;
  admin_can_edit_group_profile: boolean;
  admin_can_manage_invite_links: boolean;
  members_can_set_own_nickname: boolean;
  who_can_send_attachments: WhoOption;
  who_can_create_invite_links: WhoOption;
  who_can_approve_requests: WhoOption;
  who_can_edit_other_nicknames: WhoOption;
  who_can_edit_own_nickname: WhoOption;
  who_can_edit_group_profile: WhoOption;
}

export interface Conversation {
  id: string;
  public_id?: string | null;
  type: 'dm' | 'group' | 'channel';
  name: string | null;
  slowmode_seconds?: number;
  owner_id: string | null;
  icon_filename?: string | null;
  icon_url?: string | null;
  created_at: string;
  updated_at: string;
  role: string;
  last_read_message_id: string | null;
  unread_count?: number;
  last_message_id?: string | null;
  last_message_sender_id?: string | null;
  last_message_preview?: string | null;
  dm_user_id?: string;
  dm_username: string | null;
  dm_display_name: string | null;
  dm_avatar_url: string | null;
  member_count: number;
  muted_until?: string | null;
  permissions?: GroupPermissions;
}

export interface Attachment {
  id?: string;
  url: string;
  fallback_url?: string;
  url_expires_at?: number;
  display_url?: string;
  display_url_expires_at?: number;
  display_variants?: Partial<Record<
    'thumb' | 'small' | 'medium' | 'large',
    {
      url: string;
      expires_at: number;
      width: number;
    }
  >>;
  inline?: boolean;
  spoiler?: boolean;
  blurhash?: string;
  width?: number;
  height?: number;
  mime?: string;
  name?: string;
  size?: number;
}

export interface PickedAttachment {
  uri: string;
  name: string;
  mime: string;
  size?: number;
  width?: number;
  height?: number;
  spoiler?: boolean;
}

export type ReactionValue = string[] | { count: number; me: boolean };

export interface ForwardedMessageMetadata {
  original_message_id?: string | null;
  original_sender_id?: string | null;
  original_sender_name?: string | null;
  original_conversation_id?: string | null;
  original_conversation_name?: string | null;
}

export interface Message {
  conversation_id: string;
  conversation_public_id?: string | null;
  message_id: string;
  client_message_id?: string | null;
  sender_id: string;
  sender_name?: string | null;
  sender_username?: string | null;
  sender_avatar_url?: string | null;
  content: string;
  message_type: string;
  reply_to: string | null;
  reply_message?: Message | null;
  attachments?: string[];
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  reactions?: Record<string, ReactionValue>;
  forwarded?: ForwardedMessageMetadata | null;
  local_status?: 'sending' | 'sent' | 'failed' | 'queued';
  local_client_id?: string;
}

export interface ConversationMember {
  user_id: string;
  role: string;
  nickname: string | null;
  joined_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
}

export interface ConversationInviteLink {
  id: number;
  code: string;
  url: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  is_revoked: boolean;
  created_at: string;
}

export interface ConversationJoinRequest extends Omit<FriendRequest, 'id'> {
  id: number;
  status: string;
  invite_link_id: number | null;
  requester_user_id: string;
}

export interface InvitePreview {
  id: number;
  code: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_at: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  conversation_name: string | null;
  conversation_icon_url?: string | null;
  owner_id: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  owner_avatar_url: string | null;
  member_count: number;
}

export interface Session {
  id: string;
  device_id: string;
  device_name: string | null;
  device_type: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_live_at?: string | null;
  expires_at: string;
  is_current: boolean;
  has_live_session?: boolean;
  is_recently_active?: boolean;
}

export interface TwoFactorChallenge {
  twoFactorToken: string;
  methods: Array<'totp' | 'email' | 'backup'>;
  defaultMethod: 'totp' | 'email' | 'backup';
}

export interface AppBootstrap {
  success: true;
  user: User;
  account?: User;
  preferences?: Record<string, unknown> | null;
  friends: Friend[];
  friend_requests: {
    incoming: FriendRequest[];
    outgoing: FriendRequest[];
  };
  conversations: Conversation[];
}
