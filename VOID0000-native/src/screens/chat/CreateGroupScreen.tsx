import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { Camera, Users } from 'lucide-react-native';
import React, { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { TextField } from '../../components/common/TextField';
import { useAppData } from '../../context/AppDataContext';
import type { RootStackParamList } from '../../navigation/types';
import { chatService } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateGroup'>;

export function CreateGroupScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const { createGroup, patchConversation } = useAppData();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<{ uri: string; dataUrl: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) {
      setError('Group name is required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      let conversation = await createGroup(name.trim());
      if (icon) {
        try {
          const result = await chatService.uploadConversationIcon(conversation.public_id || conversation.id, icon.dataUrl);
          conversation = result.conversation;
          patchConversation(conversation);
        } catch {
          Alert.alert('Group created', 'The group was created, but its photo could not be uploaded. You can retry from group settings.');
        }
      }
      navigation.replace('Chat', { conversation });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create secure group');
    } finally {
      setLoading(false);
    }
  };

  const choosePhoto = async () => {
    setError('');
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [1, 1],
        base64: true,
        mediaTypes: ['images'],
        quality: 0.85,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        setError('Could not read that image. Choose another photo.');
        return;
      }
      if ((asset.fileSize || Math.ceil(asset.base64.length * 0.75)) > 7 * 1024 * 1024) {
        setError('Group photos must be 7MB or smaller.');
        return;
      }
      const mime = asset.mimeType && ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'].includes(asset.mimeType)
        ? asset.mimeType.replace('image/jpg', 'image/jpeg')
        : 'image/jpeg';
      setIcon({ uri: asset.uri, dataUrl: `data:${mime};base64,${asset.base64}` });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the photo picker.');
    }
  };

  return (
    <Screen keyboard>
      <AppHeader onBack={() => navigation.goBack()} title="Create Secure Group" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityLabel="Choose optional group photo" onPress={() => void choosePhoto()} style={[styles.photo, { backgroundColor: `${palette.accent}18`, borderColor: palette.border }]}>
          {icon ? <Image source={{ uri: icon.uri }} style={styles.photoImage} /> : <Users color={palette.accent} size={34} />}
          <View style={[styles.camera, { backgroundColor: palette.accent }]}><Camera color="#fff" size={14} /></View>
        </Pressable>
        <Text style={[styles.optional, { color: palette.muted }]}>Optional group photo</Text>
        <TextField autoFocus label="Group Name" maxLength={100} onChangeText={(value) => { setName(value); setError(''); }} onSubmitEditing={() => void submit()} placeholder="My Secure Group" value={name} />
        {error ? <FeedbackBanner message={error} /> : null}
        <View style={styles.actions}>
          <Button fullWidth onPress={() => navigation.goBack()} variant="secondary">Cancel</Button>
          <Button fullWidth loading={loading} onPress={() => void submit()}>{loading ? 'Generating Keys...' : 'Create Group'}</Button>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 42 },
  photo: { alignItems: 'center', alignSelf: 'center', borderRadius: 42, borderWidth: 1, height: 84, justifyContent: 'center', position: 'relative', width: 84 },
  photoImage: { borderRadius: 41, height: 82, width: 82 },
  camera: { alignItems: 'center', borderRadius: 14, bottom: 0, height: 28, justifyContent: 'center', position: 'absolute', right: 0, width: 28 },
  optional: { fontSize: 12, marginBottom: 28, marginTop: 10, textAlign: 'center' },
  actions: { gap: 10, marginTop: 26 },
});
