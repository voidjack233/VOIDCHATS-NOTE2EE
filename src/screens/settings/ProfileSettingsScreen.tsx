import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { Camera, RotateCcw, Save, Trash2 } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Avatar } from '../../components/common/Avatar';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { userService } from '../../services/users';
import { useTheme } from '../../theme/ThemeContext';
import type { Profile } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'ProfileSettings'>;

const MAX_BIO_LENGTH = 200;
const MAX_IMAGE_DIMENSION = 4096;
// The API caps the complete base64 data URL at 5 MiB. A conservative decoded
// limit keeps encoding overhead safely below that server boundary.
const MAX_DECODED_AVATAR_BYTES = Math.floor(3.5 * 1024 * 1024);
const MAX_AVATAR_DATA_URL_LENGTH = 5 * 1024 * 1024;

interface PendingAvatar {
  dataUrl: string;
  previewUri: string;
}

const encodedByteLength = (base64: string) => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

export function ProfileSettingsScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const { refreshUser, user } = useAuth();
  const profileId = user?.profile_id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [pendingAvatar, setPendingAvatar] = useState<PendingAvatar | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadProfile = async () => {
    if (!profileId) {
      setError('Your profile identifier is unavailable. Sign in again and retry.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await userService.profile(profileId);
      setProfile(next);
      setDisplayName(next.display_name || '');
      setBio(next.bio || '');
      setPendingAvatar(null);
      setRemoveAvatar(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load your profile.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, [profileId]);

  const fieldsChanged = useMemo(() => {
    if (!profile) return false;
    return displayName.trim() !== (profile.display_name || '').trim()
      || bio.trim() !== (profile.bio || '').trim();
  }, [bio, displayName, profile]);

  const hasChanges = Boolean(profile && (fieldsChanged || pendingAvatar || removeAvatar));
  const avatarUri = pendingAvatar?.previewUri || (removeAvatar ? null : profile?.avatar_url);

  const chooseAvatar = async () => {
    setSelecting(true);
    setError('');
    setSuccess('');
    try {
      // SDK 57 uses the system photo picker for library selection, so this
      // does not request broad media-library access.
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        allowsMultipleSelection: false,
        aspect: [1, 1],
        base64: true,
        exif: false,
        mediaTypes: ['images'],
        quality: 0.8,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset || asset.type && asset.type !== 'image') {
        setError('Choose a JPG, PNG, GIF, or WebP image.');
        return;
      }
      if (asset.width > MAX_IMAGE_DIMENSION || asset.height > MAX_IMAGE_DIMENSION) {
        setError(`Image dimensions must be ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}px or smaller.`);
        return;
      }

      const encoded = asset.base64?.replace(/\s/g, '') || '';
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        setError('The selected photo could not be read safely. Try another image.');
        return;
      }

      const dataUrl = `data:image/jpeg;base64,${encoded}`;
      if (
        encodedByteLength(encoded) > MAX_DECODED_AVATAR_BYTES
        || dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH
      ) {
        setError('The processed photo is too large. Choose an image under 3.5 MB.');
        return;
      }

      setPendingAvatar({ dataUrl, previewUri: asset.uri });
      setRemoveAvatar(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The photo picker could not be opened.');
    } finally {
      setSelecting(false);
    }
  };

  const save = async () => {
    if (!profile || !hasChanges || bio.length > MAX_BIO_LENGTH) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      let next: Profile = profile;
      if (fieldsChanged) {
        const fields = await userService.updateProfile(displayName, bio);
        next = { ...next, ...fields, id: next.id, username: next.username };
        // Commit each completed request locally so a later avatar failure can
        // be retried without resubmitting profile fields that already saved.
        setProfile(next);
        setDisplayName(next.display_name || displayName.trim());
        setBio(next.bio || '');
      }
      if (pendingAvatar) {
        const avatar = await userService.uploadAvatar(pendingAvatar.dataUrl);
        next = { ...next, ...avatar, id: next.id, username: next.username };
        setProfile(next);
      } else if (removeAvatar) {
        const avatar = await userService.removeAvatar();
        next = { ...next, ...avatar, id: next.id, username: next.username };
        setProfile(next);
      }

      setProfile(next);
      setDisplayName(next.display_name || displayName.trim());
      setBio(next.bio || '');
      setPendingAvatar(null);
      setRemoveAvatar(false);
      setSuccess('Profile updated successfully.');
      await refreshUser().catch(() => null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update your profile.');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !profile) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Profile" />
        <StateView message="Loading your profile details…" title="Loading profile" type="loading" />
      </Screen>
    );
  }

  if (!profile) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Profile" />
        <StateView
          actionLabel="Retry"
          message={error || 'Your profile could not be loaded.'}
          onAction={() => void loadProfile()}
          title="Unable to load profile"
          type="error"
        />
      </Screen>
    );
  }

  return (
    <Screen keyboard>
      <AppHeader onBack={() => navigation.goBack()} subtitle={`@${profile.username || user?.username || 'user'}`} title="Profile" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {error ? <FeedbackBanner message={error} onDismiss={() => setError('')} /> : null}
        {success ? <FeedbackBanner kind="success" message={success} onDismiss={() => setSuccess('')} /> : null}

        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>PROFILE PHOTO</Text>
          <View style={styles.avatarRow}>
            <View style={[styles.avatarRing, { borderColor: palette.border }]}>
              <Avatar
                displayName={displayName || profile.display_name}
                size={80}
                uri={avatarUri}
                username={profile.username || user?.username}
              />
            </View>
            <View style={styles.avatarActions}>
              <Button compact disabled={saving} loading={selecting} onPress={() => void chooseAvatar()} variant="secondary">
                <Camera color={palette.text} size={16} />
                <Text style={[styles.buttonLabel, { color: palette.text }]}>Choose Photo</Text>
              </Button>
              {pendingAvatar ? (
                <Button compact disabled={saving || selecting} onPress={() => setPendingAvatar(null)} variant="ghost">
                  <RotateCcw color={palette.muted} size={15} />
                  <Text style={[styles.buttonLabel, { color: palette.muted }]}>Use Current</Text>
                </Button>
              ) : removeAvatar ? (
                <Button compact disabled={saving || selecting} onPress={() => setRemoveAvatar(false)} variant="ghost">
                  <RotateCcw color={palette.muted} size={15} />
                  <Text style={[styles.buttonLabel, { color: palette.muted }]}>Undo Remove</Text>
                </Button>
              ) : profile.avatar_url ? (
                <Button compact disabled={saving || selecting} onPress={() => setRemoveAvatar(true)} variant="ghost">
                  <Trash2 color={palette.danger} size={15} />
                  <Text style={[styles.buttonLabel, { color: palette.danger }]}>Remove Photo</Text>
                </Button>
              ) : null}
            </View>
          </View>
          <Text style={[styles.help, { color: palette.muted }]}>Images are cropped to a square and uploaded as JPG. Maximum 3.5 MB after processing and 4096×4096px.</Text>
        </View>

        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>PROFILE DETAILS</Text>
          <TextField
            autoCapitalize="words"
            label="Display name"
            onChangeText={setDisplayName}
            placeholder="Enter a display name"
            value={displayName}
          />
          <Text style={[styles.help, { color: palette.muted }]}>This is how others see you. Your username remains @{profile.username || user?.username}.</Text>

          <TextField
            containerStyle={styles.bioField}
            error={bio.length > MAX_BIO_LENGTH ? `Bio must be ${MAX_BIO_LENGTH} characters or less.` : null}
            label="About me"
            maxLength={MAX_BIO_LENGTH}
            multiline
            onChangeText={setBio}
            placeholder="Tell people a little about yourself…"
            value={bio}
          />
          <Text style={[styles.counter, { color: palette.muted }]}>{bio.length}/{MAX_BIO_LENGTH}</Text>
        </View>

        <Button
          disabled={!hasChanges || bio.length > MAX_BIO_LENGTH}
          fullWidth
          loading={saving}
          onPress={() => void save()}
        >
          <Save color="#ffffff" size={17} />
          <Text style={styles.saveLabel}>Save Changes</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 34 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.05, marginBottom: 14 },
  avatarRow: { alignItems: 'center', flexDirection: 'row', gap: 16 },
  avatarRing: { borderRadius: 44, borderWidth: 2, padding: 2 },
  avatarActions: { alignItems: 'flex-start', flex: 1, gap: 7 },
  buttonLabel: { fontSize: 13, fontWeight: '700' },
  help: { fontSize: 12, lineHeight: 18, marginTop: 9 },
  bioField: { marginTop: 18 },
  counter: { fontSize: 11, marginTop: 6, textAlign: 'right' },
  saveLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
});
