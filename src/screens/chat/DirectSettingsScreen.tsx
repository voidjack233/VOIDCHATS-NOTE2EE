import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check, Pencil, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Avatar } from '../../components/common/Avatar';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { chatService } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';
import type { Conversation, ConversationMember } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'DirectSettings'>;

const memberLabel = (member: ConversationMember) => member.display_name || member.username;

export function DirectSettingsScreen({ navigation, route }: Props) {
  const { palette } = useTheme();
  const { user } = useAuth();
  const conversationId = route.params.conversation.public_id || route.params.conversation.id;
  const [conversation, setConversation] = useState<Conversation>(route.params.conversation);
  const [members, setMembers] = useState<ConversationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const detail = await chatService.conversation(conversationId);
      setConversation(detail.conversation);
      setMembers(detail.conversation.members || []);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Failed to load conversation settings');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedMembers = useMemo(() => [...members].sort((left, right) => {
    if (left.user_id === user?.id) return -1;
    if (right.user_id === user?.id) return 1;
    return memberLabel(left).localeCompare(memberLabel(right));
  }), [members, user?.id]);

  const beginEdit = (member: ConversationMember) => {
    setEditingUserId(member.user_id);
    setNickname(member.nickname || '');
    setNotice(null);
  };

  const saveNickname = async (member: ConversationMember, value: string | null) => {
    const normalized = value?.trim() || null;
    setBusyUserId(member.user_id);
    setNotice(null);
    try {
      const result = await chatService.updateNickname(conversationId, member.user_id, normalized);
      setMembers((current) => current.map((entry) => entry.user_id === member.user_id
        ? { ...entry, nickname: result.nickname }
        : entry));
      setEditingUserId(null);
      setNickname('');
      setNotice({ message: normalized ? 'Nickname saved.' : 'Nickname cleared.', kind: 'success' });
    } catch (caught) {
      setNotice({
        message: caught instanceof Error ? caught.message : 'Failed to update nickname',
        kind: 'error',
      });
    } finally {
      setBusyUserId(null);
    }
  };

  const peer = sortedMembers.find((member) => member.user_id !== user?.id);
  const peerName = peer ? memberLabel(peer) : conversation.dm_display_name || conversation.dm_username;

  return (
    <Screen keyboard>
      <AppHeader
        onBack={() => navigation.goBack()}
        subtitle="Customize names in this 1-on-1 chat."
        title="Conversation Settings"
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.peerCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Avatar
            displayName={peer?.display_name || conversation.dm_display_name}
            size={54}
            uri={peer?.avatar_url || conversation.dm_avatar_url}
            username={peer?.username || conversation.dm_username}
          />
          <View style={styles.peerCopy}>
            <Text numberOfLines={1} style={[styles.peerName, { color: palette.text }]}>
              {peerName || 'Direct Message'}
            </Text>
            <Text style={[styles.peerType, { color: palette.muted }]}>Direct Message</Text>
          </View>
        </View>

        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionTitle, { color: palette.text }]}>Nicknames</Text>
          <Text style={[styles.sectionDescription, { color: palette.muted }]}>
            Choose either person in this chat and set a conversation-specific nickname.
          </Text>
        </View>

        {notice ? (
          <FeedbackBanner
            kind={notice.kind}
            message={notice.message}
            onDismiss={() => setNotice(null)}
          />
        ) : null}

        {loading && members.length === 0 ? (
          <StateView compact title="Loading nicknames" type="loading" />
        ) : loadError && members.length === 0 ? (
          <StateView
            actionLabel="Retry"
            compact
            message={loadError}
            onAction={() => void load()}
            title="Unable to load settings"
            type="error"
          />
        ) : (
          <View style={styles.memberList}>
            {sortedMembers.map((member) => {
              const isEditing = member.user_id === editingUserId;
              const isBusy = member.user_id === busyUserId;
              const isMe = member.user_id === user?.id;
              const accountName = memberLabel(member);
              return (
                <View
                  key={member.user_id}
                  style={[styles.memberCard, { backgroundColor: palette.surface, borderColor: palette.border }]}
                >
                  <View style={styles.memberTop}>
                    <Avatar
                      displayName={member.display_name}
                      size={44}
                      uri={member.avatar_url}
                      username={member.username}
                    />
                    <View style={styles.memberCopy}>
                      <View style={styles.nameLine}>
                        <Text numberOfLines={1} style={[styles.memberName, { color: palette.text }]}>
                          {member.nickname || accountName}
                        </Text>
                        <View style={[
                          styles.participantBadge,
                          { backgroundColor: isMe ? `${palette.accent}22` : palette.hover },
                        ]}>
                          <Text style={[
                            styles.participantText,
                            { color: isMe ? palette.accent : palette.muted },
                          ]}>
                            {isMe ? 'You' : 'Participant'}
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.accountName, { color: palette.muted }]}>
                        {member.nickname
                          ? `Account name: ${accountName}`
                          : `Shown as ${accountName} in this chat`}
                      </Text>
                    </View>
                    {!isEditing ? (
                      <Pressable
                        accessibilityLabel={`${member.nickname ? 'Edit' : 'Set'} nickname for ${accountName}`}
                        hitSlop={8}
                        onPress={() => beginEdit(member)}
                        style={({ pressed }) => [
                          styles.editButton,
                          { backgroundColor: pressed ? palette.hover : palette.surfaceRaised },
                        ]}
                      >
                        <Pencil color={palette.muted} size={15} />
                        <Text style={[styles.editLabel, { color: palette.text }]}>
                          {member.nickname ? 'Edit' : 'Set'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {isEditing ? (
                    <View style={[styles.editor, { borderTopColor: palette.border }]}>
                      <TextField
                        autoFocus
                        editable={!isBusy}
                        label={`Nickname for ${accountName}`}
                        maxLength={32}
                        onChangeText={setNickname}
                        onSubmitEditing={() => void saveNickname(member, nickname)}
                        placeholder="Enter a nickname..."
                        returnKeyType="done"
                        value={nickname}
                      />
                      <View style={styles.editorActions}>
                        {member.nickname ? (
                          <Button
                            compact
                            disabled={isBusy}
                            onPress={() => void saveNickname(member, null)}
                            variant="ghost"
                          >
                            Clear nickname
                          </Button>
                        ) : <View style={styles.actionSpacer} />}
                        <Pressable
                          accessibilityLabel="Cancel"
                          disabled={isBusy}
                          onPress={() => setEditingUserId(null)}
                          style={[styles.iconButton, { backgroundColor: palette.hover }]}
                        >
                          <X color={palette.muted} size={18} />
                        </Pressable>
                        <Pressable
                          accessibilityLabel="Save nickname"
                          disabled={isBusy}
                          onPress={() => void saveNickname(member, nickname)}
                          style={[
                            styles.iconButton,
                            { backgroundColor: palette.accent, opacity: isBusy ? 0.5 : 1 },
                          ]}
                        >
                          <Check color="#ffffff" size={18} />
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 18, paddingBottom: 40 },
  peerCard: { alignItems: 'center', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 13, padding: 16 },
  peerCopy: { flex: 1, minWidth: 0 },
  peerName: { fontSize: 17, fontWeight: '800' },
  peerType: { fontSize: 12, fontWeight: '600', marginTop: 3 },
  sectionHeading: { marginTop: 5 },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  sectionDescription: { fontSize: 12, lineHeight: 18, marginTop: 5 },
  memberList: { gap: 11 },
  memberCard: { borderRadius: 15, borderWidth: 1, overflow: 'hidden', padding: 13 },
  memberTop: { alignItems: 'center', flexDirection: 'row', gap: 11 },
  memberCopy: { flex: 1, minWidth: 0 },
  nameLine: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  memberName: { flexShrink: 1, fontSize: 15, fontWeight: '700' },
  accountName: { fontSize: 11, lineHeight: 16, marginTop: 3 },
  participantBadge: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  participantText: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  editButton: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', gap: 5, paddingHorizontal: 9, paddingVertical: 7 },
  editLabel: { fontSize: 12, fontWeight: '700' },
  editor: { borderTopWidth: StyleSheet.hairlineWidth, gap: 10, marginTop: 13, paddingTop: 13 },
  editorActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  actionSpacer: { flex: 1 },
  iconButton: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 42 },
});
