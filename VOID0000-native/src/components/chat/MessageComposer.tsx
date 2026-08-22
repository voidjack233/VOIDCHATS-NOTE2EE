import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Plus,
  SendHorizontal,
  X,
} from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_ATTACHMENTS } from '../../config';
import { useTheme } from '../../theme/ThemeContext';
import type { Message, PickedAttachment } from '../../types/models';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

function fileTooLarge(item: PickedAttachment) {
  return Boolean(item.size && item.size > MAX_ATTACHMENT_BYTES);
}

interface MessageComposerProps {
  conversationName: string;
  replyTo: Message | null;
  editing: Message | null;
  busy: boolean;
  canAttach?: boolean;
  canSend?: boolean;
  restrictionReason?: string;
  slowmodeRemaining?: number;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (content: string, attachments: PickedAttachment[]) => Promise<boolean>;
  onTyping: () => void;
}

export function MessageComposer({
  conversationName,
  replyTo,
  editing,
  busy,
  canAttach = true,
  canSend = true,
  restrictionReason,
  slowmodeRemaining = 0,
  onCancelReply,
  onCancelEdit,
  onSend,
  onTyping,
}: MessageComposerProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const lastTypingAt = useRef(0);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (editing) {
      setContent(editing.content || '');
      setAttachments([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing?.message_id]);

  useEffect(() => {
    if (replyTo) requestAnimationFrame(() => inputRef.current?.focus());
  }, [replyTo?.message_id]);

  useEffect(() => {
    if (!canAttach) setAttachments([]);
  }, [canAttach]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const appendPicked = (picked: PickedAttachment[]) => {
    const valid: PickedAttachment[] = [];
    let sawLarge = false;
    let sawUnsupported = false;
    for (const item of picked) {
      if (fileTooLarge(item)) {
        sawLarge = true;
        continue;
      }
      if (item.mime.startsWith('image/') && !IMAGE_TYPES.has(item.mime.toLowerCase())) {
        sawUnsupported = true;
        continue;
      }
      valid.push(item);
    }
    if (sawLarge) Alert.alert('Attachment Too Large', 'Each attachment must be 10 MB or smaller.', [{ text: 'Okay' }]);
    if (sawUnsupported) Alert.alert('Unsupported Image', 'Choose a JPEG, PNG, GIF, or WebP image.');
    setAttachments((current) => {
      const available = Math.max(0, MAX_ATTACHMENTS - current.length);
      if (valid.length > available) Alert.alert('Upload limit reached', `You can attach up to ${MAX_ATTACHMENTS} files.`);
      return [...current, ...valid.slice(0, available)];
    });
  };

  const chooseMedia = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, MAX_ATTACHMENTS - attachments.length),
      quality: 0.9,
    });
    if (result.canceled) return;
    appendPicked(result.assets.map((asset, index) => ({
      uri: asset.uri,
      name: asset.fileName || `image-${Date.now()}-${index}.jpg`,
      mime: asset.mimeType || 'image/jpeg',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      spoiler: false,
    })));
  };

  const chooseFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: '*/*',
    });
    if (result.canceled) return;
    appendPicked(result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mime: asset.mimeType || 'application/octet-stream',
      size: asset.size,
    })));
  };

  const openAttachmentPicker = () => {
    if (editing || !canAttach) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      Alert.alert('Upload limit reached', `You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Media', 'Files'], cancelButtonIndex: 0 },
        (index) => {
          if (index === 1) void chooseMedia();
          if (index === 2) void chooseFiles();
        },
      );
      return;
    }
    Alert.alert('Add attachment', undefined, [
      { text: 'Media', onPress: () => void chooseMedia() },
      { text: 'Files', onPress: () => void chooseFiles() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const changeContent = (value: string) => {
    setContent(value);
    const now = Date.now();
    if (value.trim() && now - lastTypingAt.current > 3_000) {
      lastTypingAt.current = now;
      onTyping();
    }
  };

  const submit = async () => {
    if (!canSend || busy || slowmodeRemaining > 0 || (!content.trim() && !attachments.length)) return;
    const sent = await onSend(content.trim(), attachments);
    if (!sent) return;
    setContent('');
    setAttachments([]);
  };

  const placeholder = slowmodeRemaining > 0
    ? `Slowmode active: wait ${slowmodeRemaining}s`
    : !canSend
      ? restrictionReason || 'You have view-only access'
    : attachments.length
      ? 'Add a caption... (optional)'
      : `Message ${conversationName}`;

  return (
    <View style={[
      styles.root,
      {
        backgroundColor: palette.bg,
        borderTopColor: palette.border,
        paddingBottom: keyboardVisible ? 8 : Math.max(8, insets.bottom),
      },
    ]}>
      {replyTo ? (
        <View style={[styles.banner, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <View style={styles.bannerText}>
            <Text style={[styles.bannerTitle, { color: palette.accent }]}>Replying</Text>
            <Text numberOfLines={1} style={[styles.bannerPreview, { color: palette.muted }]}>
              {replyTo.is_deleted ? '[deleted]' : replyTo.content || (replyTo.attachments?.length ? 'Attachment' : 'Message')}
            </Text>
          </View>
          <Pressable accessibilityLabel="Cancel reply" hitSlop={10} onPress={onCancelReply}><X color={palette.muted} size={18} /></Pressable>
        </View>
      ) : null}
      {editing ? (
        <View style={[styles.banner, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <View style={styles.bannerText}>
            <Text style={[styles.bannerTitle, { color: palette.accent }]}>Editing message</Text>
            <Text numberOfLines={1} style={[styles.bannerPreview, { color: palette.muted }]}>Attachments cannot be changed while editing.</Text>
          </View>
          <Pressable accessibilityLabel="Cancel edit" hitSlop={10} onPress={() => { onCancelEdit(); setContent(''); }}><X color={palette.muted} size={18} /></Pressable>
        </View>
      ) : null}
      {attachments.length ? (
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={styles.previewScroll} contentContainerStyle={styles.previewContent}>
          {attachments.map((attachment, index) => {
            const image = attachment.mime.startsWith('image/');
            return (
              <View key={`${attachment.uri}-${index}`} style={[styles.preview, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                {image ? <Image blurRadius={attachment.spoiler ? 12 : 0} source={{ uri: attachment.uri }} style={styles.previewImage} /> : <FileText color={palette.accent} size={28} />}
                <Text numberOfLines={1} style={[styles.previewName, { color: palette.text }]}>{attachment.name}</Text>
                {image ? (
                  <Pressable
                    accessibilityLabel={attachment.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
                    onPress={() => setAttachments((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, spoiler: !item.spoiler } : item))}
                    style={[styles.previewAction, styles.previewSpoiler]}
                  >
                    {attachment.spoiler ? <Eye color="#fff" size={14} /> : <EyeOff color="#fff" size={14} />}
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel="Remove attachment"
                  onPress={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  style={[styles.previewAction, styles.previewRemove]}
                >
                  <X color="#fff" size={14} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      {slowmodeRemaining > 0 ? (
        <Text style={[styles.slowmode, { color: palette.warning }]}>Slowmode is enabled. You can send again in {slowmodeRemaining}s.</Text>
      ) : !canSend ? (
        <Text style={[styles.slowmode, { color: palette.warning }]}>{restrictionReason || 'Your role has view-only access in this conversation.'}</Text>
      ) : null}
      <View style={[styles.composer, { backgroundColor: palette.hover, borderColor: palette.border }]}>
        <Pressable
          accessibilityLabel="Add attachment"
          disabled={Boolean(editing) || busy || !canAttach || !canSend}
          hitSlop={8}
          onPress={openAttachmentPicker}
          style={({ pressed }) => [styles.iconButton, { opacity: editing || busy || !canAttach || !canSend ? 0.35 : pressed ? 0.6 : 1 }]}
        >
          {attachments.length ? <ImageIcon color={palette.text} size={20} /> : <Plus color={palette.muted} size={22} />}
        </Pressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          blurOnSubmit={false}
          editable={canSend && !busy && slowmodeRemaining <= 0}
          maxLength={8_000}
          multiline
          onChangeText={changeContent}
          placeholder={placeholder}
          placeholderTextColor={palette.faint}
          selectionColor={palette.accent}
          style={[styles.input, { color: palette.text }]}
          value={content}
        />
        <Pressable
          accessibilityLabel={editing ? 'Save message' : 'Send message'}
          disabled={!canSend || busy || slowmodeRemaining > 0 || (!content.trim() && !attachments.length)}
          hitSlop={8}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: palette.accent, opacity: !canSend || busy || slowmodeRemaining > 0 || (!content.trim() && !attachments.length) ? 0.35 : pressed ? 0.7 : 1 },
          ]}
        >
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <SendHorizontal color="#fff" size={18} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8 },
  banner: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 10, marginBottom: 7, paddingHorizontal: 10, paddingVertical: 8 },
  bannerText: { flex: 1, minWidth: 0 },
  bannerTitle: { fontSize: 11, fontWeight: '800' },
  bannerPreview: { fontSize: 11, marginTop: 2 },
  previewScroll: { marginBottom: 8, maxHeight: 94 },
  previewContent: { gap: 8, paddingRight: 8 },
  preview: { alignItems: 'center', borderRadius: 10, borderWidth: 1, height: 88, justifyContent: 'center', overflow: 'hidden', padding: 5, width: 88 },
  previewImage: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  previewName: { backgroundColor: 'rgba(0,0,0,0.58)', bottom: 0, fontSize: 9, left: 0, paddingHorizontal: 5, paddingVertical: 3, position: 'absolute', right: 0 },
  previewAction: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.68)', borderRadius: 12, height: 24, justifyContent: 'center', position: 'absolute', top: 4, width: 24 },
  previewSpoiler: { left: 4 },
  previewRemove: { right: 4 },
  slowmode: { fontSize: 11, marginBottom: 7, paddingHorizontal: 4 },
  composer: { alignItems: 'flex-end', borderRadius: 18, borderWidth: 1, flexDirection: 'row', minHeight: 46, padding: 4 },
  iconButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 38 },
  input: { flex: 1, fontSize: 15, lineHeight: 20, maxHeight: 120, minHeight: 38, paddingHorizontal: 6, paddingVertical: 9, textAlignVertical: 'center' },
  send: { alignItems: 'center', borderRadius: 17, height: 34, justifyContent: 'center', margin: 2, width: 34 },
});
