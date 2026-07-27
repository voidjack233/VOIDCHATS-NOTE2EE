export interface GroupPermissions {
  admin_can_remove_members: boolean;
  admin_can_approve_join_requests: boolean;
  admin_can_edit_member_nicknames: boolean;
  admin_can_edit_group_profile: boolean;
  admin_can_manage_invite_links: boolean;
  members_can_set_own_nickname: boolean;
  who_can_send_attachments: 'everyone' | 'admins' | 'owner';
  who_can_create_invite_links: 'everyone' | 'admins' | 'owner';
  who_can_approve_requests: 'everyone' | 'admins' | 'owner';
  who_can_edit_other_nicknames: 'everyone' | 'admins' | 'owner';
  who_can_edit_own_nickname: 'everyone' | 'admins' | 'owner';
  who_can_edit_group_profile: 'everyone' | 'admins' | 'owner';
}

export interface Conversation {
  id: string;
  public_id?: string | null;
  type: 'dm' | 'group' | 'channel';
  name: string | null;
  slowmode_seconds?: number;
  owner_id: string | null;
  icon_filename: string | null;
  icon_url?: string | null;
  parent_conversation_id?: string | null;
  parent_public_id?: string | null;
  created_at: string;
  updated_at: string;
  first_message_at?: string | null;
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
  channels?: Conversation[];
  permissions?: GroupPermissions;
}

export interface Attachment {
  id?: string;
  url: string;
  fallback_url?: string;
  url_expires_at?: number;
  display_url?: string;
  display_url_expires_at?: number;
  inline?: boolean;
  spoiler?: boolean;
  blurhash?: string;
  width?: number;
  height?: number;
  mime?: string;
  name?: string;
  size?: number;
}

export interface ReactionMap {
  [emoji: string]: string[] | { count: number; me: boolean };
}

export interface ForwardedMessageMetadata {
  original_message_id?: string | null;
  original_sender_id?: string | null;
  original_sender_name?: string | null;
  original_conversation_id?: string | null;
  original_conversation_name?: string | null;
}

export interface MessageMentionMetadata {
  user_id: string;
  username: string;
}

export interface LinkPreviewMetadata {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site_name?: string | null;
  favicon?: string | null;
}

export interface Message {
  conversation_id: string;
  conversation_public_id?: string | null;
  message_id: string;
  client_message_id?: string | null;
  sender_id: string;
  content: string;
  message_type: string;
  reply_to: string | null;
  attachments?: string[];
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  reactions?: ReactionMap;
  forwarded?: ForwardedMessageMetadata | null;
  mentions?: MessageMentionMetadata[];
  link_preview?: LinkPreviewMetadata | null;
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

export interface ConversationJoinRequest {
  id: number;
  status: string;
  created_at: string;
  invite_link_id: number | null;
  requester_user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
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

export interface ConversationDetails extends Conversation {
  members?: ConversationMember[];
}
