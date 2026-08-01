import { Check, MessageCircle, MoreVertical, Search, UserPlus, X } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppData } from '../../context/AppDataContext';
import { socialService } from '../../services/social';
import { useTheme } from '../../theme/ThemeContext';
import type { Friend, FriendRequest, Profile } from '../../types/models';
import { Avatar } from '../common/Avatar';
import { Button } from '../common/Button';
import { PresenceDot } from '../common/PresenceDot';
import { StateView } from '../common/StateView';
import { TextField } from '../common/TextField';

type Tab = 'online' | 'all' | 'pending' | 'add';

interface FriendsPaneProps {
  onMessage: (friend: Friend) => void;
  onProfile: (profileId: string, initial?: Profile) => void;
}

export function FriendsPane({ onMessage, onProfile }: FriendsPaneProps) {
  const { palette } = useTheme();
  const {
    friends,
    incoming,
    outgoing,
    presences,
    removeFriend,
    acceptRequest,
    rejectRequest,
    cancelRequest,
    sendRequest,
  } = useAppData();
  const [tab, setTab] = useState<Tab>('online');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const shownFriends = useMemo(() => friends.filter((friend) => {
    const presence = presences[friend.id]?.status || friend.status || 'offline';
    if (tab === 'online' && presence === 'offline') return false;
    const haystack = `${friend.display_name || ''} ${friend.username}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }).sort((a, b) => {
    const order = { online: 0, idle: 1, offline: 2 };
    const left = presences[a.id]?.status || a.status || 'offline';
    const right = presences[b.id]?.status || b.status || 'offline';
    return order[left] - order[right];
  }), [friends, presences, search, tab]);

  const confirmRemove = (friend: Friend) => Alert.alert(
    'Remove Friend',
    `Are you sure you want to permanently remove ${friend.display_name || friend.username} from your friends list?`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove Friend', style: 'destructive', onPress: () => void removeFriend(friend.friendship_id) },
    ],
  );

  const performSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    try {
      const users = await socialService.search(query);
      setResults(users);
      if (!users.length) setError('No users found');
    } catch {
      setResults([]);
      setError('Search failed');
    } finally {
      setSearching(false);
    }
  };

  const relationship = (profileId?: string) => {
    if (!profileId) return 'none';
    if (friends.some((friend) => friend.profile_id === profileId)) return 'friends';
    if (incoming.some((request) => request.profile_id === profileId)) return 'incoming';
    if (outgoing.some((request) => request.profile_id === profileId)) return 'outgoing';
    return 'none';
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <TabButton active={tab === 'online'} label="Online" onPress={() => setTab('online')} />
        <TabButton active={tab === 'all'} label="All" onPress={() => setTab('all')} />
        {(incoming.length || outgoing.length) ? <TabButton active={tab === 'pending'} badge={incoming.length} label="Pending" onPress={() => setTab('pending')} /> : null}
        <Pressable onPress={() => setTab('add')} style={[styles.add, { backgroundColor: tab === 'add' ? 'transparent' : palette.accent, borderColor: palette.accent }]}>
          <UserPlus color={tab === 'add' ? palette.accent : '#fff'} size={16} />
          <Text style={{ color: tab === 'add' ? palette.accent : '#fff', fontSize: 12, fontWeight: '700' }}>Add Friend</Text>
        </Pressable>
      </View>

      {tab === 'add' ? (
        <View style={styles.addContent}>
          <Text style={[styles.addTitle, { color: palette.text }]}>ADD FRIEND</Text>
          <Text style={[styles.helper, { color: palette.muted }]}>You can add friends with their void username.</Text>
          <View style={styles.searchRow}>
            <TextField containerStyle={styles.searchField} onChangeText={setQuery} onSubmitEditing={() => void performSearch()} placeholder="You can add friends with their void username." value={query} />
            <Button compact loading={searching} onPress={() => void performSearch()}>Search</Button>
          </View>
          {error ? <Text style={{ color: palette.danger, fontSize: 13 }}>{error}</Text> : null}
          {results.length ? <Text style={[styles.sectionLabel, { color: palette.muted }]}>SEARCH RESULTS</Text> : null}
          <FlatList
            data={results}
            keyExtractor={(item) => item.profile_id || item.id}
            renderItem={({ item }) => {
              const state = relationship(item.profile_id);
              return (
                <Pressable onPress={() => onProfile(item.profile_id || item.id, item)} style={[styles.result, { borderColor: palette.border }]}>
                  <Avatar displayName={item.display_name} size={46} uri={item.avatar_url} username={item.username} />
                  <View style={styles.friendCopy}>
                    <Text numberOfLines={1} style={[styles.friendName, { color: palette.text }]}>{item.display_name || item.username}</Text>
                    <Text style={[styles.friendStatus, { color: palette.muted }]}>@{item.username}</Text>
                  </View>
                  {state === 'none' ? (
                    <Button compact loading={busyId === item.profile_id} onPress={async () => {
                      const id = item.profile_id || item.id;
                      setBusyId(id);
                      try { await sendRequest(id); } catch { setError('Failed to send request'); } finally { setBusyId(null); }
                    }}>Add Friend</Button>
                  ) : state === 'incoming' ? (
                    <Button compact loading={busyId === item.profile_id} onPress={async () => {
                      const request = incoming.find((entry) => entry.profile_id === item.profile_id);
                      if (!request) return;
                      setBusyId(item.profile_id || item.id);
                      try { await acceptRequest(request.friendship_id); } catch { setError('Failed to accept request'); } finally { setBusyId(null); }
                    }} variant="success">Accept</Button>
                  ) : <Text style={{ color: state === 'friends' ? palette.accent : palette.success, fontSize: 12, fontWeight: '700' }}>{state === 'friends' ? 'Friends' : 'Pending'}</Text>}
                </Pressable>
              );
            }}
          />
        </View>
      ) : tab === 'pending' ? (
        <FlatList
          contentContainerStyle={styles.list}
          data={[
            ...incoming.map((request) => ({ kind: 'incoming' as const, request })),
            ...outgoing.map((request) => ({ kind: 'outgoing' as const, request })),
          ]}
          keyExtractor={(item) => `${item.kind}-${item.request.friendship_id}`}
          ListEmptyComponent={<StateView compact title="No pending requests" />}
          renderItem={({ item, index }) => {
            const previous = index > 0 ? (index <= incoming.length ? 'incoming' : 'outgoing') : null;
            const showHeader = index === 0 || item.kind !== previous;
            return (
              <View>
                {showHeader ? <Text style={[styles.sectionLabel, { color: palette.muted }]}>{item.kind === 'incoming' ? `INCOMING — ${incoming.length}` : `SENT — ${outgoing.length}`}</Text> : null}
                <PendingRow
                  incoming={item.kind === 'incoming'}
                  onAccept={() => void acceptRequest(item.request.friendship_id)}
                  onCancel={() => void cancelRequest(item.request.friendship_id)}
                  onReject={() => void rejectRequest(item.request.friendship_id)}
                  request={item.request}
                />
              </View>
            );
          }}
        />
      ) : (
        <>
          <View style={styles.searchBox}>
            <Search color={palette.muted} size={17} />
            <TextField containerStyle={styles.searchField} onChangeText={setSearch} placeholder="Search friends" value={search} />
          </View>
          <Text style={[styles.heading, { color: palette.muted }]}>{tab === 'online' ? `Online — ${shownFriends.length}` : `All Friends — ${shownFriends.length}`}</Text>
          <FlatList
            data={shownFriends}
            keyExtractor={(item) => String(item.friendship_id)}
            ListEmptyComponent={<StateView compact title={tab === 'online' ? 'No friends online right now' : 'No friends found'} />}
            renderItem={({ item }) => {
              const presence = presences[item.id]?.status || item.status || 'offline';
              return (
                <Pressable onPress={() => onProfile(item.profile_id || item.id, item)} style={({ pressed }) => [styles.friendRow, { backgroundColor: pressed ? `${palette.hover}88` : 'transparent' }]}>
                  <View style={styles.avatarWrap}>
                    <Avatar dimmed={presence === 'offline'} displayName={item.display_name} size={42} uri={item.avatar_url} username={item.username} />
                    <View style={styles.dot}><PresenceDot status={presence} /></View>
                  </View>
                  <Pressable onPress={() => onMessage(item)} style={styles.friendCopy}>
                    <Text numberOfLines={1} style={[styles.friendName, { color: palette.text }]}>{item.display_name || item.username}</Text>
                    <Text style={[styles.friendStatus, { color: palette.muted }]}>{presence === 'online' ? 'Online' : presence === 'idle' ? 'Idle' : 'Offline'}</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="Message" hitSlop={8} onPress={() => onMessage(item)} style={styles.iconButton}><MessageCircle color={palette.muted} size={20} /></Pressable>
                  <Pressable accessibilityLabel="More Options" hitSlop={8} onPress={() => confirmRemove(item)} style={styles.iconButton}><MoreVertical color={palette.muted} size={20} /></Pressable>
                </Pressable>
              );
            }}
          />
        </>
      )}
    </View>
  );

  function TabButton({ label, active, badge, onPress }: { label: string; active: boolean; badge?: number; onPress: () => void }) {
    return (
      <Pressable onPress={onPress} style={[styles.tab, { backgroundColor: active ? palette.hover : 'transparent' }]}>
        <Text style={{ color: active ? palette.text : palette.muted, fontSize: 12, fontWeight: '700' }}>{label}</Text>
        {badge ? <View style={styles.pendingBadge}><Text style={styles.pendingText}>{badge}</Text></View> : null}
      </Pressable>
    );
  }

  function PendingRow({ request, incoming: isIncoming, onAccept, onReject, onCancel }: { request: FriendRequest; incoming: boolean; onAccept: () => void; onReject: () => void; onCancel: () => void }) {
    return (
      <View style={[styles.pendingRow, { backgroundColor: `${palette.hover}55` }]}>
        <Avatar displayName={request.display_name} size={40} uri={request.avatar_url} username={request.username} />
        <View style={styles.friendCopy}>
          <Text style={[styles.friendName, { color: palette.text }]}>{request.display_name || request.username}</Text>
          <Text style={[styles.friendStatus, { color: palette.muted }]}>@{request.username}{isIncoming ? '' : ' · Pending'}</Text>
        </View>
        {isIncoming ? (
          <><Pressable onPress={onAccept} style={styles.iconButton}><Check color={palette.success} size={19} /></Pressable><Pressable onPress={onReject} style={styles.iconButton}><X color={palette.danger} size={19} /></Pressable></>
        ) : <Button compact onPress={onCancel} variant="ghost"><Text style={{ color: palette.danger, fontSize: 12 }}>Cancel</Text></Button>}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabs: { alignItems: 'center', flexDirection: 'row', gap: 4, padding: 10 },
  tab: { alignItems: 'center', borderRadius: 8, flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingVertical: 8 },
  add: { alignItems: 'center', borderRadius: 9, borderWidth: 1, flexDirection: 'row', gap: 5, marginLeft: 'auto', paddingHorizontal: 9, paddingVertical: 7 },
  pendingBadge: { alignItems: 'center', backgroundColor: '#ef4444', borderRadius: 8, height: 16, justifyContent: 'center', minWidth: 16, paddingHorizontal: 4 },
  pendingText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  searchBox: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  searchField: { flex: 1 },
  heading: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, paddingHorizontal: 16, paddingVertical: 12, textTransform: 'uppercase' },
  list: { flexGrow: 1, padding: 12 },
  friendRow: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 10, marginHorizontal: 8, padding: 9 },
  avatarWrap: { position: 'relative' },
  dot: { bottom: -1, position: 'absolute', right: -1 },
  friendCopy: { flex: 1, minWidth: 0 },
  friendName: { fontSize: 14, fontWeight: '700' },
  friendStatus: { fontSize: 12, marginTop: 3 },
  iconButton: { padding: 7 },
  addContent: { flex: 1, gap: 12, padding: 16 },
  addTitle: { fontSize: 18, fontWeight: '800' },
  helper: { fontSize: 13 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  sectionLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 8, marginTop: 12 },
  result: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, paddingVertical: 12 },
  pendingRow: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 10, marginBottom: 8, padding: 11 },
});
