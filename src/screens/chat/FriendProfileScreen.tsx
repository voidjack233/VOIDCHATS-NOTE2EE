import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CalendarDays, MessageCircle } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Avatar } from '../../components/common/Avatar';
import { Button } from '../../components/common/Button';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { userService } from '../../services/users';
import { useTheme } from '../../theme/ThemeContext';
import type { Profile } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'FriendProfile'>;

export function FriendProfileScreen({ navigation, route }: Props) {
  const { palette } = useTheme();
  const { user } = useAuth();
  const { friends, startDM } = useAppData();
  const [profile, setProfile] = useState<Profile | null>(route.params.initial || null);
  const [loading, setLoading] = useState(!route.params.initial);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setProfile(await userService.profile(route.params.profileId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [route.params.profileId]);

  if (loading && !profile) return <Screen><AppHeader onBack={() => navigation.goBack()} title="Profile" /><StateView title="Loading profile" type="loading" /></Screen>;
  if (!profile) return <Screen><AppHeader onBack={() => navigation.goBack()} title="Profile" /><StateView actionLabel="Retry" message={error} onAction={() => void load()} title="Unable to load profile" type="error" /></Screen>;

  const friend = friends.find((entry) => entry.profile_id === route.params.profileId || entry.id === profile.id);
  const isMe = profile.id === user?.id || route.params.profileId === user?.profile_id;

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} title="Profile" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Avatar displayName={profile.display_name} size={88} uri={profile.avatar_url} username={profile.username} />
          <Text style={[styles.name, { color: palette.text }]}>{profile.display_name || profile.username}</Text>
          <Text style={[styles.username, { color: palette.muted }]}>@{profile.username}</Text>
          <Text style={[styles.bio, { color: palette.muted }]}>{profile.bio?.trim() || 'No bio yet'}</Text>
          {profile.created_at ? (
            <View style={styles.memberSince}>
              <CalendarDays color={palette.faint} size={16} />
              <Text style={[styles.memberText, { color: palette.muted }]}>Member Since {new Date(profile.created_at).toLocaleDateString()}</Text>
            </View>
          ) : null}
          {isMe ? (
            <Button fullWidth onPress={() => navigation.navigate('ProfileSettings')} variant="secondary">Edit Profile</Button>
          ) : friend ? (
            <Button fullWidth onPress={() => void startDM(friend.id).then((conversation) => navigation.navigate('Chat', { conversation }))}>
              <MessageCircle color="#fff" size={18} /><Text style={styles.buttonText}>Message</Text>
            </Button>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: { alignItems: 'center', borderRadius: 18, borderWidth: 1, padding: 24 },
  name: { fontSize: 22, fontWeight: '800', marginTop: 16 },
  username: { fontSize: 14, marginTop: 4 },
  bio: { fontSize: 14, fontStyle: 'italic', lineHeight: 21, marginVertical: 22, textAlign: 'center' },
  memberSince: { alignItems: 'center', flexDirection: 'row', gap: 7, marginBottom: 24 },
  memberText: { fontSize: 12 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
