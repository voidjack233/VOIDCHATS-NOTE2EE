import { MicOff, Users } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import type { Conversation, PresenceStatus } from '../../types/models';
import { Avatar } from '../common/Avatar';
import { PresenceDot } from '../common/PresenceDot';

interface ConversationRowProps {
  conversation: Conversation;
  currentUserId?: string;
  presence?: PresenceStatus;
  onPress: () => void;
  onLongPress?: () => void;
}

export function conversationTitle(conversation: Conversation) {
  return conversation.type === 'dm'
    ? conversation.dm_display_name || conversation.dm_username || 'Direct Message'
    : conversation.name || 'Unnamed Group';
}

export function ConversationRow({
  conversation,
  currentUserId,
  presence = 'offline',
  onPress,
  onLongPress,
}: ConversationRowProps) {
  const { palette } = useTheme();
  const unread = Math.min(conversation.unread_count || 0, 100);
  const ownPreview = conversation.last_message_sender_id === currentUserId;
  const preview = conversation.last_message_preview
    ? `${ownPreview ? 'You: ' : ''}${conversation.last_message_preview}`
    : conversation.type === 'dm' ? 'Start a conversation' : `${conversation.member_count} members`;
  const muted = Boolean(conversation.muted_until && Date.parse(conversation.muted_until) > Date.now());

  return (
    <Pressable
      accessibilityLabel={`Open ${conversationTitle(conversation)}`}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: palette.border, backgroundColor: pressed ? palette.hover : 'transparent' },
      ]}
    >
      <View style={styles.avatar}>
        {conversation.type === 'dm' ? (
          <Avatar
            dimmed={presence === 'offline'}
            displayName={conversation.dm_display_name}
            size={40}
            uri={conversation.dm_avatar_url}
            username={conversation.dm_username}
          />
        ) : conversation.icon_url ? (
          <Avatar displayName={conversation.name} size={40} uri={conversation.icon_url} />
        ) : (
          <View style={[styles.groupFallback, { backgroundColor: `${palette.accent}22` }]}>
            <Users color={palette.accent} size={19} />
          </View>
        )}
        {conversation.type === 'dm' ? <View style={styles.presence}><PresenceDot status={presence} /></View> : null}
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, { color: palette.text }]}>{conversationTitle(conversation)}</Text>
          {muted ? <MicOff color={palette.faint} size={14} /> : null}
        </View>
        <Text numberOfLines={1} style={[styles.preview, { color: palette.muted }]}>{preview}</Text>
      </View>
      {unread > 0 ? (
        <View style={[styles.badge, { backgroundColor: palette.accent }]}>
          <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 62, paddingHorizontal: 12, paddingVertical: 10 },
  avatar: { marginRight: 12, position: 'relative' },
  presence: { bottom: -1, position: 'absolute', right: -1 },
  groupFallback: { alignItems: 'center', borderRadius: 20, height: 40, justifyContent: 'center', width: 40 },
  copy: { flex: 1, minWidth: 0 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  title: { flexShrink: 1, fontSize: 14, fontWeight: '700' },
  preview: { fontSize: 12, marginTop: 4 },
  badge: { alignItems: 'center', borderRadius: 10, justifyContent: 'center', marginLeft: 10, minHeight: 20, minWidth: 20, paddingHorizontal: 6 },
  badgeText: { color: '#ffffff', fontSize: 10, fontWeight: '800' },
});
