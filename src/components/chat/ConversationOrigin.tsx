import { CalendarDays, UsersRound } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import type { Conversation, Friend } from '../../types/models';
import { Avatar } from '../common/Avatar';

interface ConversationOriginProps {
  conversation: Conversation;
  friend?: Friend;
}

function relationshipDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function ConversationOrigin({ conversation, friend }: ConversationOriginProps) {
  const { palette } = useTheme();
  const direct = conversation.type === 'dm';
  const name = direct
    ? conversation.dm_display_name || conversation.dm_username || 'Direct Message'
    : conversation.name || 'Unnamed Group';
  const since = relationshipDate(friend?.friends_since);

  return (
    <View accessibilityRole="summary" style={styles.root}>
      <View style={[styles.avatarHalo, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <Avatar
          displayName={name}
          size={72}
          uri={direct ? conversation.dm_avatar_url : conversation.icon_url}
          username={direct ? conversation.dm_username : undefined}
        />
      </View>
      <Text style={[styles.name, { color: palette.text }]}>{name}</Text>
      {direct && conversation.dm_username ? (
        <Text style={[styles.username, { color: palette.muted }]}>@{conversation.dm_username}</Text>
      ) : null}
      <Text style={[styles.description, { color: palette.muted }]}>
        {direct
          ? `This is the beginning of your direct message history with ${name}.`
          : `This is the beginning of ${name}.`}
      </Text>
      {direct && since ? (
        <View style={[styles.detailPill, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <CalendarDays color={palette.accent} size={14} />
          <Text style={[styles.detailText, { color: palette.muted }]}>Friends since {since}</Text>
        </View>
      ) : !direct ? (
        <View style={[styles.detailPill, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <UsersRound color={palette.accent} size={14} />
          <Text style={[styles.detailText, { color: palette.muted }]}>
            {conversation.member_count || 0} member{conversation.member_count === 1 ? '' : 's'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function EmptyConversationState() {
  const { palette } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: palette.text }]}>No messages yet</Text>
      <Text style={[styles.emptyText, { color: palette.muted }]}>Say hello when you are ready.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarHalo: {
    borderRadius: 44,
    borderWidth: 1,
    padding: 5,
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
    maxWidth: 320,
    textAlign: 'center',
  },
  detailPill: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  detailText: {
    fontSize: 11,
    fontWeight: '600',
  },
  empty: {
    alignItems: 'center',
    minHeight: 120,
    paddingBottom: 32,
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  emptyText: {
    fontSize: 12,
    marginTop: 4,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  name: {
    fontSize: 24,
    fontWeight: '900',
    marginTop: 16,
    textAlign: 'center',
  },
  root: {
    alignItems: 'center',
    paddingBottom: 24,
    paddingHorizontal: 22,
    paddingTop: 46,
  },
  username: {
    fontSize: 13,
    marginTop: 3,
  },
});
