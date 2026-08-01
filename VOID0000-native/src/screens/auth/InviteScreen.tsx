import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CheckCircle2, Lock, Users } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { chatService } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';
import type { InvitePreview } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'Invite'>;
type JoinStatus = 'none' | 'pending' | 'declined' | 'approved' | 'member';

export function InviteScreen({ navigation, route }: Props) {
  const { user, status: authStatus } = useAuth();
  const { palette } = useTheme();
  const { code } = route.params;
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [joinStatus, setJoinStatus] = useState<JoinStatus>('none');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void chatService.invitePreview(code).then(async (next) => {
      if (!active) return;
      setPreview(next);
      if (user && authStatus === 'authenticated') {
        const state = await chatService.inviteStatus(code);
        if (!active) return;
        setJoinStatus(state.status);
        setConversationId(state.conversation_public_id || null);
      }
    }).catch((caught) => {
      if (active) setError(toApiError(caught, 'This invite is unavailable.').message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [authStatus, code, user]);

  const requestJoin = async () => {
    if (!user) {
      await AsyncStorage.setItem('void_pending_invite', code);
      navigation.navigate('SignIn', { pendingInvite: code });
      return;
    }
    setRequesting(true);
    setError('');
    setNotice('');
    try {
      await chatService.requestJoin(code);
      setJoinStatus('pending');
      setNotice('Join request sent. The owner needs to approve it before you can enter.');
    } catch (caught) {
      const apiError = toApiError(caught, 'Failed to request access.');
      if (apiError.code === 'ALREADY_MEMBER') {
        setJoinStatus('member');
        const id = typeof apiError.payload?.conversation_public_id === 'string'
          ? apiError.payload.conversation_public_id
          : preview?.conversation_public_id || null;
        setConversationId(id);
        setNotice('You are already a member of this group.');
      } else {
        setError(apiError.message);
      }
    } finally {
      setRequesting(false);
    }
  };

  if (loading) return <Screen><StateView message="Loading invite details..." title="Loading" type="loading" /></Screen>;

  return (
    <Screen>
      <AppHeader onBack={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate(user ? 'Home' : 'SignIn')} title="Invite Link" />
      <ScrollView contentContainerStyle={styles.page}>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <View style={[styles.hero, { backgroundColor: palette.bg, borderBottomColor: palette.border }]}>
            {preview?.conversation_icon_url ? (
              <Image source={{ uri: preview.conversation_icon_url }} style={styles.icon} />
            ) : (
              <View style={[styles.icon, styles.fallback, { backgroundColor: `${palette.accent}22` }]}>
                <Text style={[styles.initial, { color: palette.accent }]}>{preview?.conversation_name?.trim().charAt(0).toUpperCase() || '#'}</Text>
              </View>
            )}
            <View style={styles.heroCopy}>
              <Text style={[styles.eyebrow, { color: palette.muted }]}>INVITE LINK</Text>
              <Text style={[styles.title, { color: palette.text }]}>{preview?.conversation_name || 'Group Invite'}</Text>
              <Text style={[styles.subtitle, { color: palette.muted }]}>
                {preview ? `${preview.owner_display_name || preview.owner_username || 'Unknown owner'} is inviting people to this group.` : 'This invite link is no longer available.'}
              </Text>
            </View>
          </View>

          <View style={styles.body}>
            {error ? <FeedbackBanner message={error} /> : null}
            {notice ? <FeedbackBanner kind="success" message={notice} /> : null}
            {preview ? (
              <View style={styles.stats}>
                <Stat icon={<Users color={palette.muted} size={16} />} label="MEMBERS" value={String(preview.member_count)} />
                <Stat icon={<Lock color={palette.muted} size={16} />} label="HISTORY" value="New messages only" />
                <Stat icon={<CheckCircle2 color={palette.muted} size={16} />} label="EXPIRES" value={preview.expires_at ? new Date(preview.expires_at).toLocaleString() : 'No expiration'} />
              </View>
            ) : null}
            <View style={styles.actions}>
              {!user ? <Button fullWidth onPress={() => void requestJoin()}>Log In To Continue</Button> : null}
              {user && ['none', 'declined', 'approved'].includes(joinStatus) ? (
                <Button fullWidth loading={requesting} onPress={() => void requestJoin()}>
                  {requesting ? 'Sending Request...' : joinStatus === 'none' ? 'Request Join' : 'Request Again'}
                </Button>
              ) : null}
              {user && joinStatus === 'pending' ? <Button disabled fullWidth variant="secondary">Request Pending</Button> : null}
              {user && joinStatus === 'member' ? (
                <Button fullWidth onPress={() => {
                  const conversation = conversationId
                    ? { id: conversationId, public_id: conversationId, type: 'group' as const, name: preview?.conversation_name || 'Unnamed Group', owner_id: preview?.owner_id || null, created_at: preview?.created_at || '', updated_at: preview?.created_at || '', role: 'member', last_read_message_id: null, dm_username: null, dm_display_name: null, dm_avatar_url: null, member_count: preview?.member_count || 0 }
                    : null;
                  if (conversation) navigation.navigate('Chat', { conversation });
                  else navigation.navigate('Home');
                }}>Open Group</Button>
              ) : null}
              <Button fullWidth onPress={() => navigation.navigate(user ? 'Home' : 'SignIn')} variant="secondary">Back To Chats</Button>
            </View>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );

  function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
      <View style={[styles.stat, { backgroundColor: palette.bg, borderColor: palette.border }]}>
        <View style={styles.statLabel}>{icon}<Text style={[styles.eyebrow, { color: palette.muted }]}>{label}</Text></View>
        <Text style={[styles.statValue, { color: palette.text }]}>{value}</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', padding: 16, paddingVertical: 28 },
  card: { borderRadius: 24, borderWidth: 1, overflow: 'hidden' },
  hero: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', gap: 16, padding: 22 },
  icon: { borderRadius: 20, height: 64, width: 64 },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 25, fontWeight: '700' },
  heroCopy: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.8 },
  title: { fontSize: 22, fontWeight: '700', marginTop: 7 },
  subtitle: { fontSize: 13, lineHeight: 19, marginTop: 7 },
  body: { gap: 18, padding: 20 },
  stats: { gap: 10 },
  stat: { borderRadius: 16, borderWidth: 1, padding: 14 },
  statLabel: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  statValue: { fontSize: 15, fontWeight: '700', marginTop: 10 },
  actions: { gap: 10 },
});
