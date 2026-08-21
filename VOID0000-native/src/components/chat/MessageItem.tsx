import { useMappingHelper, useRecyclingState } from '@shopify/flash-list';
import { FileText, Forward, ImageOff, Reply } from 'lucide-react-native';
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import {
  Alert,
  Animated,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { API_URL } from '../../config';
import { parseAttachment } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';
import type { Attachment, Message, ReactionValue } from '../../types/models';
import { Avatar } from '../common/Avatar';

export interface NormalizedReaction {
  count: number;
  me: boolean;
}

export function normalizeReaction(value: ReactionValue, currentUserId?: string): NormalizedReaction {
  if (Array.isArray(value)) {
    return { count: value.length, me: Boolean(currentUserId && value.includes(currentUserId)) };
  }
  return { count: Number(value?.count) || 0, me: Boolean(value?.me) };
}

function attachmentUrl(url: string) {
  if (/^(https?:|data:|file:|content:|blob:)/i.test(url)) return url;
  return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function isImageAttachment(attachment: Attachment) {
  if (attachment.mime?.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp)(?:\?|$)/i.test(attachment.url);
}

function formatBytes(value?: number) {
  if (!value || value < 1) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const INLINE_PATTERN = /(\|\|[\s\S]+?\|\||```[\s\S]+?```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|https?:\/\/[^\s]+)/g;

function FormattedMessage({
  content,
  color,
  fontSize,
  messageIdentity,
  onHeightWillChange,
}: {
  content: string;
  color: string;
  fontSize: number;
  messageIdentity: string;
  onHeightWillChange?: () => void;
}) {
  const [spoilersRevealed, setSpoilersRevealed] = useRecyclingState(false, [messageIdentity, content]);
  const pieces = useMemo(() => content.split(INLINE_PATTERN).filter(Boolean), [content]);

  const openExternalLink = (url: string) => {
    Alert.alert('Open External Link?', url, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Link', onPress: () => void Linking.openURL(url) },
    ]);
  };

  return (
    <Text selectable style={{ color, fontSize, lineHeight: Math.round(fontSize * 1.42) }}>
      {pieces.map((piece, index) => {
        if (/^https?:\/\//i.test(piece)) {
          return <Text key={`${piece}-${index}`} onPress={() => openExternalLink(piece)} style={styles.link}>{piece}</Text>;
        }
        if (piece.startsWith('||') && piece.endsWith('||')) {
          return (
            <Text
              accessibilityHint="Reveals hidden message text"
              key={`${piece}-${index}`}
              onPress={() => {
                onHeightWillChange?.();
                setSpoilersRevealed((current) => !current);
              }}
              style={{ backgroundColor: spoilersRevealed ? 'rgba(255,255,255,0.12)' : color, color: spoilersRevealed ? color : 'transparent' }}
            >
              {piece.slice(2, -2)}
            </Text>
          );
        }
        if (piece.startsWith('```') && piece.endsWith('```')) {
          return <Text key={`${piece}-${index}`} style={styles.code}>{piece.slice(3, -3).replace(/^\w+\n/, '')}</Text>;
        }
        if (piece.startsWith('`') && piece.endsWith('`')) {
          return <Text key={`${piece}-${index}`} style={styles.code}>{piece.slice(1, -1)}</Text>;
        }
        if (piece.startsWith('**') && piece.endsWith('**')) {
          return <Text key={`${piece}-${index}`} style={styles.bold}>{piece.slice(2, -2)}</Text>;
        }
        if (piece.startsWith('~~') && piece.endsWith('~~')) {
          return <Text key={`${piece}-${index}`} style={styles.strike}>{piece.slice(2, -2)}</Text>;
        }
        return <Text key={`${piece}-${index}`}>{piece}</Text>;
      })}
    </Text>
  );
}

function ReplyPreview({ message, onPress }: { message: Message; onPress?: () => void }) {
  const { palette } = useTheme();
  const preview = message.reply_message;
  const label = preview?.is_deleted
    ? '[deleted]'
    : preview?.content || (preview?.attachments?.length ? 'Attachment' : 'Message unavailable');
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[styles.reply, { borderLeftColor: palette.accent, backgroundColor: `${palette.bg}99` }]}>
      <Reply color={palette.accent} size={12} />
      <View style={styles.replyTextWrap}>
        <Text numberOfLines={1} style={[styles.replyAuthor, { color: palette.accent }]}>
          {preview?.sender_name || preview?.sender_username || 'Replying'}
        </Text>
        <Text numberOfLines={1} style={[styles.replyText, { color: palette.muted }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

function AttachmentView({
  attachmentIdentity,
  raw,
  onOpen,
  onHeightWillChange,
}: {
  attachmentIdentity: string;
  raw: string;
  onOpen?: (attachment: Attachment) => void;
  onHeightWillChange?: () => void;
}) {
  const { palette } = useTheme();
  const [failed, setFailed] = useRecyclingState(false, [attachmentIdentity, raw]);
  const [spoilerRevealed, setSpoilerRevealed] = useRecyclingState(false, [attachmentIdentity, raw]);
  const attachment = useMemo(() => parseAttachment(raw), [raw]);
  const image = isImageAttachment(attachment);
  const uri = attachmentUrl(attachment.url || attachment.fallback_url || '');

  if (image) {
    return (
      <Pressable
        accessibilityLabel={attachment.spoiler && !spoilerRevealed ? 'Reveal spoiler' : 'Open image'}
        onPress={() => {
          if (attachment.spoiler && !spoilerRevealed) {
            onHeightWillChange?.();
            setSpoilerRevealed(true);
          }
          else onOpen?.({ ...attachment, url: uri });
        }}
        style={[styles.imageFrame, { backgroundColor: palette.bg }]}
      >
        {failed ? (
          <View style={styles.unavailable}>
            <ImageOff color={palette.muted} size={24} />
            <Text style={[styles.unavailableText, { color: palette.muted }]}>Attachment unavailable</Text>
          </View>
        ) : (
          <Image
            blurRadius={attachment.spoiler && !spoilerRevealed ? 28 : 0}
            onError={() => {
              onHeightWillChange?.();
              setFailed(true);
            }}
            resizeMode="cover"
            source={{ uri }}
            style={styles.image}
          />
        )}
        {attachment.spoiler && !spoilerRevealed && !failed ? (
          <View style={styles.spoilerLabel}><Text style={styles.spoilerLabelText}>SPOILER</Text></View>
        ) : null}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => onOpen?.({ ...attachment, url: uri })}
      style={[styles.file, { backgroundColor: palette.bg, borderColor: palette.border }]}
    >
      <FileText color={palette.accent} size={24} />
      <View style={styles.fileText}>
        <Text numberOfLines={1} style={[styles.fileName, { color: palette.text }]}>{attachment.name || 'Attachment'}</Text>
        <Text style={[styles.fileMeta, { color: palette.muted }]}>{attachment.mime || 'File'}{attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}</Text>
      </View>
    </Pressable>
  );
}

interface MessageItemProps {
  message: Message;
  animateEntrance?: boolean;
  currentUserId?: string;
  comfortable: boolean;
  fontSize: number;
  spacing: number;
  showHeader: boolean;
  onLongPress: (message: Message) => void;
  onToggleReaction: (message: Message, emoji: string) => void;
  onOpenAttachment: (attachment: Attachment) => void;
  onHeightWillChange?: () => void;
  onJumpToReply?: (messageId: string) => void;
  onRetry?: (message: Message) => void;
}

export function MessageItem({
  message,
  animateEntrance = false,
  currentUserId,
  comfortable,
  fontSize,
  spacing,
  showHeader,
  onLongPress,
  onToggleReaction,
  onOpenAttachment,
  onHeightWillChange,
  onJumpToReply,
  onRetry,
}: MessageItemProps) {
  const { palette } = useTheme();
  const own = message.sender_id === currentUserId;
  const stableIdentity = message.client_message_id || message.local_client_id || message.message_id;
  const opacity = useRef(new Animated.Value(animateEntrance ? 0 : 1)).current;
  const translateX = useRef(new Animated.Value(animateEntrance ? (own ? 8 : -8) : 0)).current;
  const { getMappingKey } = useMappingHelper();
  const rightAligned = comfortable && own;
  const attachments = message.attachments || [];
  const reactionEntries = Object.entries(message.reactions || {})
    .map(([emoji, value]) => [emoji, normalizeReaction(value, currentUserId)] as const)
    .filter(([, value]) => value.count > 0);

  useLayoutEffect(() => {
    opacity.stopAnimation();
    translateX.stopAnimation();
    opacity.setValue(animateEntrance ? 0 : 1);
    translateX.setValue(animateEntrance ? (own ? 8 : -8) : 0);
    if (!animateEntrance) return;

    const animation = Animated.parallel([
      Animated.timing(opacity, {
        duration: 180,
        toValue: 1,
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        duration: 180,
        toValue: 0,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [animateEntrance, opacity, own, stableIdentity, translateX]);

  if (message.message_type === 'system') {
    return (
      <Animated.View style={{ opacity, transform: [{ translateX }] }}>
        <View style={[styles.systemWrap, { marginVertical: Math.max(4, spacing / 2) }]}>
          <Text style={[styles.system, { color: palette.muted, backgroundColor: palette.surface }]}>{message.content}</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={{ opacity, transform: [{ translateX }] }}>
    <View style={[styles.row, rightAligned && styles.rowOwn, { marginTop: showHeader ? Math.max(8, spacing) : 2 }]}>
      {!rightAligned ? (
        <View style={styles.avatarColumn}>
          {showHeader ? <Avatar displayName={message.sender_name} size={32} uri={message.sender_avatar_url} username={message.sender_username} /> : null}
        </View>
      ) : null}
      <Pressable
        delayLongPress={360}
        onLongPress={() => onLongPress(message)}
        style={[styles.messageColumn, rightAligned && styles.messageColumnOwn]}
      >
        {showHeader ? (
          <View style={[styles.meta, rightAligned && styles.metaOwn]}>
            <Text numberOfLines={1} style={[styles.author, { color: own ? palette.accent : palette.text }]}>
              {own ? 'You' : message.sender_name || message.sender_username || 'Unknown'}
            </Text>
            <Text style={[styles.time, { color: palette.faint }]}>{displayTime(message.created_at)}</Text>
          </View>
        ) : null}
        <View style={[
          styles.bubble,
          rightAligned && styles.bubbleOwn,
          {
            backgroundColor: rightAligned ? `${palette.accent}2b` : palette.surface,
            borderColor: rightAligned ? `${palette.accent}50` : palette.border,
          },
        ]}>
          {message.forwarded ? (
            <View style={styles.forwarded}><Forward color={palette.muted} size={12} /><Text style={[styles.forwardedText, { color: palette.muted }]}>Forwarded message</Text></View>
          ) : null}
          {message.reply_to ? <ReplyPreview message={message} onPress={() => onJumpToReply?.(message.reply_to!)} /> : null}
          {attachments.length ? (
            <View style={styles.attachments}>
              {attachments.map((raw, index) => {
                const attachmentIdentity = `${stableIdentity}:${index}`;
                return (
                  <AttachmentView
                    attachmentIdentity={attachmentIdentity}
                    key={getMappingKey(`${attachmentIdentity}:${raw}`, index)}
                    onOpen={onOpenAttachment}
                    onHeightWillChange={onHeightWillChange}
                    raw={raw}
                  />
                );
              })}
            </View>
          ) : null}
          {message.content ? (
            <View style={attachments.length ? styles.caption : undefined}>
              <FormattedMessage
                color={message.is_deleted ? palette.muted : palette.text}
                content={message.content}
                fontSize={fontSize}
                messageIdentity={stableIdentity}
                onHeightWillChange={onHeightWillChange}
              />
            </View>
          ) : null}
          <View style={[styles.statusRow, rightAligned && styles.statusRowOwn]}>
            {message.is_edited && !message.is_deleted ? <Text style={[styles.status, { color: palette.faint }]}>(edited)</Text> : null}
            {message.local_status === 'sending' ? <Text style={[styles.status, { color: palette.faint }]}>sending...</Text> : null}
            {message.local_status === 'queued' ? <Text style={[styles.status, { color: palette.warning }]}>queued</Text> : null}
            {message.local_status === 'failed' ? (
              <Pressable onPress={() => onRetry?.(message)}><Text style={[styles.status, styles.retry, { color: palette.danger }]}>failed to send · Retry</Text></Pressable>
            ) : null}
          </View>
        </View>
        {reactionEntries.length ? (
          <View style={[styles.reactions, rightAligned && styles.reactionsOwn]}>
            {reactionEntries.map(([emoji, value]) => (
              <Pressable
                accessibilityLabel={`${emoji}, ${value.count} reactions${value.me ? ', reacted' : ''}`}
                key={emoji}
                onPress={() => onToggleReaction(message, emoji)}
                style={[
                  styles.reaction,
                  {
                    backgroundColor: value.me ? `${palette.accent}29` : palette.surface,
                    borderColor: value.me ? palette.accent : palette.border,
                  },
                ]}
              >
                <Text style={styles.emoji}>{emoji}</Text>
                <Text style={[styles.reactionCount, { color: value.me ? palette.accent : palette.muted }]}>{value.count}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Pressable>
    </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'flex-end', flexDirection: 'row', paddingHorizontal: 12 },
  rowOwn: { justifyContent: 'flex-end' },
  avatarColumn: { alignItems: 'center', alignSelf: 'stretch', marginRight: 8, width: 32 },
  messageColumn: { alignItems: 'flex-start', maxWidth: '86%', minWidth: 50 },
  messageColumnOwn: { alignItems: 'flex-end' },
  meta: { alignItems: 'baseline', flexDirection: 'row', gap: 7, marginBottom: 4, paddingHorizontal: 3 },
  metaOwn: { justifyContent: 'flex-end' },
  author: { flexShrink: 1, fontSize: 13, fontWeight: '800' },
  time: { fontSize: 10 },
  bubble: { borderRadius: 14, borderBottomLeftRadius: 5, borderWidth: StyleSheet.hairlineWidth, minWidth: 42, overflow: 'hidden', padding: 10 },
  bubbleOwn: { borderBottomLeftRadius: 14, borderBottomRightRadius: 5 },
  attachments: { gap: 6 },
  caption: { marginTop: 8 },
  imageFrame: { borderRadius: 10, height: 190, minWidth: 220, overflow: 'hidden', position: 'relative' },
  image: { height: '100%', width: '100%' },
  unavailable: { alignItems: 'center', flex: 1, gap: 7, justifyContent: 'center', padding: 20 },
  unavailableText: { fontSize: 12 },
  spoilerLabel: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 7, left: '35%', paddingHorizontal: 8, paddingVertical: 5, position: 'absolute', top: '42%' },
  spoilerLabelText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  file: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 10, minWidth: 220, padding: 11 },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 13, fontWeight: '700' },
  fileMeta: { fontSize: 10, marginTop: 2 },
  reply: { alignItems: 'center', borderLeftWidth: 3, borderRadius: 7, flexDirection: 'row', gap: 7, marginBottom: 7, padding: 7 },
  replyTextWrap: { flex: 1, minWidth: 0 },
  replyAuthor: { fontSize: 10, fontWeight: '800' },
  replyText: { fontSize: 11, marginTop: 1 },
  forwarded: { alignItems: 'center', flexDirection: 'row', gap: 5, marginBottom: 6 },
  forwardedText: { fontSize: 10, fontWeight: '700' },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 3 },
  statusRowOwn: { justifyContent: 'flex-end' },
  status: { fontSize: 10 },
  retry: { fontWeight: '700', textDecorationLine: 'underline' },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5 },
  reactionsOwn: { justifyContent: 'flex-end' },
  reaction: { alignItems: 'center', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 4, minHeight: 26, paddingHorizontal: 8, paddingVertical: 3 },
  emoji: { fontSize: 14 },
  reactionCount: { fontSize: 11, fontWeight: '700' },
  systemWrap: { alignItems: 'center', paddingHorizontal: 24 },
  system: { borderRadius: 14, fontSize: 11, overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 6, textAlign: 'center' },
  link: { color: '#60a5fa', textDecorationLine: 'underline' },
  code: { backgroundColor: 'rgba(0,0,0,0.24)', fontFamily: 'monospace' },
  bold: { fontWeight: '800' },
  strike: { textDecorationLine: 'line-through' },
});
