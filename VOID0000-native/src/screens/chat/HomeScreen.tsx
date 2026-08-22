import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ChevronUp, MessageCircle, Plus, Search, Settings, Users } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ConversationRow } from '../../components/chat/ConversationRow';
import { FriendsPane } from '../../components/chat/FriendsPane';
import { Avatar } from '../../components/common/Avatar';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { PresenceDot } from '../../components/common/PresenceDot';
import { PresenceStatusSheet } from '../../components/common/PresenceStatusSheet';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { getPresenceModeLabel, type PresenceMode } from '../../features/presence/presenceStatus';
import type { RootStackParamList } from '../../navigation/types';
import { chatService } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';
import type { Conversation } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;
type Mode = 'friends' | 'dm' | 'group';

export function HomeScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const { user } = useAuth();
  const {
    conversations,
    friends,
    presences,
    loading,
    refreshing,
    error,
    connectionState,
    isOnline,
    presenceMode,
    ownStatus,
    isUpdatingPresenceMode,
    presenceModeError,
    refresh,
    setPresenceMode,
    startDM,
    patchConversation,
    removeConversation,
  } = useAppData();
  const [mode, setMode] = useState<Mode>('dm');
  const [search, setSearch] = useState('');
  const [presenceSheetOpen, setPresenceSheetOpen] = useState(false);
  const myFriendRecord = friends.find((friend) => friend.id === user?.id);

  const filtered = useMemo(() => conversations.filter((conversation) => {
    if (conversation.type !== mode) return false;
    const name = conversation.type === 'dm'
      ? conversation.dm_display_name || conversation.dm_username || ''
      : conversation.name || '';
    return name.toLowerCase().includes(search.trim().toLowerCase());
  }), [conversations, mode, search]);

  const openConversationMenu = (conversation: Conversation) => {
    if (conversation.type !== 'dm') return;
    const muted = Boolean(conversation.muted_until && Date.parse(conversation.muted_until) > Date.now());
    Alert.alert(conversation.dm_display_name || conversation.dm_username || 'Direct Message', undefined, [
      {
        text: muted ? `Unmute ${conversation.dm_display_name || conversation.dm_username || 'chat'}` : `Mute ${conversation.dm_display_name || conversation.dm_username || 'chat'}`,
        onPress: () => void chatService.muteDM(conversation.id, !muted).then(() => patchConversation({
          ...conversation,
          muted_until: muted ? null : '2099-12-31T23:59:59Z',
        })),
      },
      {
        text: 'Close Chat',
        style: 'destructive',
        onPress: () => void chatService.closeDM(conversation.id).then(() => removeConversation(conversation.id)),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const messageFriend = async (friend: typeof friends[number]) => {
    try {
      const conversation = await startDM(friend.id);
      navigation.navigate('Chat', { conversation });
    } catch (caught) {
      Alert.alert('Could not open chat', caught instanceof Error ? caught.message : 'Please try again.');
    }
  };

  const selectPresenceMode = async (nextMode: PresenceMode) => {
    if (nextMode === presenceMode || await setPresenceMode(nextMode)) {
      setPresenceSheetOpen(false);
    }
  };

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: palette.border }]}>
        <Text style={[styles.headerTitle, { color: palette.text }]}>Messages</Text>
        {mode === 'group' ? (
          <Pressable accessibilityLabel="Create new group" hitSlop={10} onPress={() => navigation.navigate('CreateGroup')} style={[styles.headerButton, { backgroundColor: palette.hover }]}>
            <Plus color={palette.text} size={19} />
          </Pressable>
        ) : null}
      </View>

      {!isOnline ? <FeedbackBanner kind="warning" message="You're offline. Check your connection. The app will resume automatically." /> : connectionState === 'reconnecting' && !loading ? <FeedbackBanner kind="info" message="Reconnecting to server..." /> : null}

      <View style={[styles.segmentWrap, { borderBottomColor: palette.border }]}>
        <View style={[styles.segment, { backgroundColor: palette.surface, borderColor: palette.hover }]}>
          <SegmentButton active={mode === 'friends'} icon={<Users size={15} />} label="Friends" onPress={() => setMode('friends')} />
          <SegmentButton active={mode === 'dm'} icon={<MessageCircle size={15} />} label="DMs" onPress={() => setMode('dm')} />
          <SegmentButton active={mode === 'group'} icon={<Users size={15} />} label="Groups" onPress={() => setMode('group')} />
        </View>
      </View>

      {mode === 'friends' ? (
        <FriendsPane
          onMessage={(friend) => void messageFriend(friend)}
          onProfile={(profileId, initial) => navigation.navigate('FriendProfile', { profileId, initial })}
        />
      ) : (
        <View style={styles.content}>
          <View style={styles.searchRow}>
            <Search color={palette.muted} size={17} />
            <TextField
              containerStyle={styles.searchField}
              onChangeText={setSearch}
              placeholder={mode === 'dm' ? 'Search DMs...' : 'Search Groups...'}
              value={search}
            />
          </View>
          <Text style={[styles.section, { color: palette.muted }]}>{mode === 'dm' ? 'DIRECT MESSAGES' : 'YOUR GROUPS'}</Text>
          {loading && !conversations.length ? (
            <StateView message="Preparing your conversations..." title="Loading" type="loading" />
          ) : error && !conversations.length ? (
            <StateView actionLabel="Retry" message={error} onAction={() => void refresh()} title="Connection Error" type="error" />
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              ListEmptyComponent={<StateView compact title={search.trim() ? 'No results found' : mode === 'dm' ? 'No DMs yet.' : 'No groups yet.'} />}
              refreshControl={<RefreshControl colors={[palette.accent]} onRefresh={() => void refresh()} refreshing={refreshing} tintColor={palette.accent} />}
              renderItem={({ item }) => (
                <ConversationRow
                  conversation={item}
                  currentUserId={user?.id}
                  onLongPress={() => openConversationMenu(item)}
                  onPress={() => navigation.navigate('Chat', { conversation: item })}
                  presence={item.dm_user_id ? presences[item.dm_user_id]?.status : 'offline'}
                />
              )}
            />
          )}
        </View>
      )}

      <View style={[styles.identity, { borderTopColor: palette.border, backgroundColor: palette.bg }]}>
        <Pressable
          onPress={() => user?.profile_id && navigation.navigate('FriendProfile', { profileId: user.profile_id })}
          style={({ pressed }) => [styles.identityMain, { backgroundColor: pressed ? palette.hover : 'transparent' }]}
        >
          <View style={styles.identityAvatar}>
            <Avatar displayName={myFriendRecord?.display_name} size={32} uri={myFriendRecord?.avatar_url} username={user?.username} />
            <View style={styles.identityPresence}><PresenceDot size={11} status={ownStatus} /></View>
          </View>
          <View style={styles.identityCopy}>
            <Text numberOfLines={1} style={[styles.identityName, { color: palette.text }]}>{myFriendRecord?.display_name || user?.username || 'User'}</Text>
            <Text numberOfLines={1} style={[styles.identityStatus, { color: palette.muted }]}>{getPresenceModeLabel(presenceMode)}</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel="Change active status"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setPresenceSheetOpen(true)}
          style={styles.settings}
        >
          <ChevronUp color={palette.muted} size={18} />
        </Pressable>
        <Pressable accessibilityLabel="Settings" hitSlop={10} onPress={() => navigation.navigate('Settings')} style={styles.settings}>
          <Settings color={palette.muted} size={21} />
        </Pressable>
      </View>

      <PresenceStatusSheet
        busy={isUpdatingPresenceMode}
        error={presenceModeError}
        mode={presenceMode}
        onClose={() => setPresenceSheetOpen(false)}
        onSelect={(nextMode) => void selectPresenceMode(nextMode)}
        ownStatus={ownStatus}
        visible={presenceSheetOpen}
      />
    </Screen>
  );

  function SegmentButton({ active, icon, label, onPress }: { active: boolean; icon: React.ReactElement<{ color?: string }>; label: string; onPress: () => void }) {
    const color = active ? palette.text : palette.muted;
    return (
      <Pressable onPress={onPress} style={[styles.segmentButton, { backgroundColor: active ? palette.hover : 'transparent' }]}>
        {React.cloneElement(icon, { color })}
        <Text style={{ color, fontSize: 12, fontWeight: '700' }}>{label}</Text>
      </Pressable>
    );
  }
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', height: 64, justifyContent: 'space-between', paddingHorizontal: 16 },
  headerTitle: { fontSize: 17, fontWeight: '800' },
  headerButton: { alignItems: 'center', borderRadius: 10, height: 36, justifyContent: 'center', width: 36 },
  segmentWrap: { borderBottomWidth: StyleSheet.hairlineWidth, padding: 10 },
  segment: { borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 4, padding: 4 },
  segmentButton: { alignItems: 'center', borderRadius: 12, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 9 },
  content: { flex: 1 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: 9, paddingHorizontal: 12, paddingTop: 10 },
  searchField: { flex: 1 },
  section: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, paddingHorizontal: 14, paddingVertical: 12 },
  identity: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', height: 58, paddingHorizontal: 8 },
  identityMain: { alignItems: 'center', borderRadius: 8, flex: 1, flexDirection: 'row', gap: 9, minWidth: 0, padding: 4 },
  identityAvatar: { position: 'relative' },
  identityPresence: { bottom: -1, position: 'absolute', right: -1 },
  identityCopy: { flex: 1, minWidth: 0 },
  identityName: { fontSize: 13, fontWeight: '700' },
  identityStatus: { fontSize: 10, marginTop: 2 },
  settings: { padding: 9 },
});
