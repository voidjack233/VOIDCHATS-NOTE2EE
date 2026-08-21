import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Forward,
  Pencil,
  Reply,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { MessageComposer } from '../../components/chat/MessageComposer';
import { MessageItem, normalizeReaction } from '../../components/chat/MessageItem';
import { Avatar } from '../../components/common/Avatar';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { API_URL } from '../../config';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import {
  NativeMessageTimeline,
  type NativeMessageTimelineHandle,
  type TimelineMessage,
  type TimelineRenderInfo,
} from '../../features/chat/timeline';
import type { RootStackParamList } from '../../navigation/types';
import { ApiError } from '../../services/api';
import { chatService, parseAttachment, serializeAttachment } from '../../services/chat';
import { gateway } from '../../services/gateway';
import { outbox, type OutboxJob } from '../../services/outbox';
import { useTheme } from '../../theme/ThemeContext';
import type {
  Attachment,
  Conversation,
  ConversationMember,
  Message,
  PickedAttachment,
  ReactionValue,
} from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
const MAX_REACTIONS = 10;

function fullUrl(url: string) {
  if (/^(https?:|data:|file:|content:|blob:)/i.test(url)) return url;
  return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function isImage(attachment: Attachment) {
  return Boolean(attachment.mime?.startsWith('image/') || /\.(jpe?g|png|gif|webp)(?:\?|$)/i.test(attachment.url));
}

function messageIdentity(message: Message) {
  return message.client_message_id || message.local_client_id || message.message_id;
}

function dedupeMessages(messages: Message[]) {
  const deduped: Message[] = [];
  for (const message of messages) {
    const aliases = new Set([
      message.message_id,
      message.client_message_id,
      message.local_client_id,
    ].filter((id): id is string => Boolean(id)));
    const existingIndex = deduped.findIndex((candidate) => [
      candidate.message_id,
      candidate.client_message_id,
      candidate.local_client_id,
    ].some((id) => Boolean(id && aliases.has(id))));
    if (existingIndex < 0) {
      deduped.push(message);
      continue;
    }
    const existing = deduped[existingIndex];
    const existingIsServer = !existing.local_status;
    const nextIsServer = !message.local_status || message.local_status === 'sent';
    const merged = nextIsServer
      ? { ...existing, ...message, local_status: undefined }
      : existingIsServer
        ? { ...message, ...existing, local_status: undefined }
        : { ...existing, ...message };
    deduped[existingIndex] = {
      ...merged,
      client_message_id: message.client_message_id || existing.client_message_id,
      local_client_id: message.local_client_id || existing.local_client_id,
    };
  }
  return deduped.sort((left, right) => {
    const time = (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0);
    return time || right.message_id.localeCompare(left.message_id);
  });
}

function historyFenceFor(conversation: Conversation, members: ConversationMember[], userId?: string) {
  if (conversation.type === 'dm' || !userId) return null;
  const joinedAt = members.find((member) => member.user_id === userId)?.joined_at;
  const joinedAtMs = Date.parse(joinedAt || '');
  return Number.isFinite(joinedAtMs) ? joinedAtMs : null;
}

function filterHistoryAtFence(messages: Message[], joinedAtMs: number | null) {
  if (joinedAtMs === null) return { messages, reachedFence: false };
  let reachedFence = false;
  const visible = messages.filter((message) => {
    const createdAt = Date.parse(message.created_at);
    if (!Number.isFinite(createdAt)) return true;
    if (createdAt < joinedAtMs) {
      reachedFence = true;
      return false;
    }
    return true;
  });
  return { messages: visible, reachedFence };
}

function conversationMatches(message: { conversation_id?: string; conversation_public_id?: string | null }, conversation: Conversation) {
  return message.conversation_id === conversation.id ||
    message.conversation_id === conversation.public_id ||
    message.conversation_public_id === conversation.id ||
    message.conversation_public_id === conversation.public_id;
}

function queuedMessage(job: OutboxJob, userId: string): Message {
  return {
    conversation_id: job.conversationId,
    message_id: job.clientId,
    client_message_id: job.clientId,
    local_client_id: job.clientId,
    sender_id: userId,
    sender_name: 'You',
    content: job.content,
    message_type: 'text',
    reply_to: job.replyTo,
    attachments: job.attachments.map((attachment) => serializeAttachment({
      url: attachment.uri,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      spoiler: attachment.spoiler,
    })),
    is_edited: false,
    edited_at: null,
    is_deleted: false,
    created_at: job.createdAt,
    local_status: 'queued',
  };
}

function typingSentence(names: string[]) {
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, ${names[2]} are typing...`;
  return `${names[0]}, ${names[1]} and others are typing...`;
}

function meetsWhoThreshold(role: string, threshold: 'everyone' | 'admins' | 'owner') {
  if (role === 'owner') return true;
  if (threshold === 'everyone') return role !== 'viewer';
  if (threshold === 'admins') return role === 'admin';
  return false;
}

function applyReactionEvent(message: Message, event: { emoji: string; user_id?: string; action: 'add' | 'remove' }, currentUserId?: string) {
  const reactions = { ...(message.reactions || {}) };
  const current = reactions[event.emoji]
    ? normalizeReaction(reactions[event.emoji]!, currentUserId)
    : { count: 0, me: false };
  if (event.action === 'add') {
    reactions[event.emoji] = {
      count: current.count + 1,
      me: current.me || event.user_id === currentUserId,
    };
  } else if (current.count <= 1) {
    delete reactions[event.emoji];
  } else {
    reactions[event.emoji] = {
      count: current.count - 1,
      me: event.user_id === currentUserId ? false : current.me,
    };
  }
  return { ...message, reactions };
}

export function ChatScreen({ navigation, route }: Props) {
  const { palette, density, messageSpacing, chatFontScale } = useTheme();
  const { user } = useAuth();
  const {
    conversations,
    connectionState,
    isOnline,
    patchConversation,
    removeConversation,
    setActiveConversation,
  } = useAppData();
  const [conversation, setConversation] = useState(route.params.conversation);
  const [members, setMembers] = useState<ConversationMember[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialDataReady, setInitialDataReady] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<Attachment | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [forwardBusyId, setForwardBusyId] = useState<string | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [slowmodeUntil, setSlowmodeUntil] = useState(0);
  const [outboxRetryTick, setOutboxRetryTick] = useState(0);
  const [, setClock] = useState(0);
  const timelineRef = useRef<NativeMessageTimelineHandle>(null);
  const messageListRef = useRef(messages);
  messageListRef.current = messages;
  const lastReadRef = useRef<string | null>(null);
  const jobsRef = useRef(new Map<string, OutboxJob>());
  const processingRef = useRef(new Set<string>());
  const pendingOwnReactionRef = useRef(new Map<string, number>());
  const seenReactionEventsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const historyFenceRef = useRef<number | null>(null);
  const pendingResumeRefreshGenerationRef = useRef<number | null>(null);
  const loadGenerationRef = useRef(0);
  const initialDataReadyGenerationRef = useRef<number | null>(null);
  const newMessageIdsRef = useRef(new Set<string>());
  const localOutputIdsRef = useRef(new Set<string>());
  const timelineMessageCacheRef = useRef(new WeakMap<Message, {
    context: string;
    value: TimelineMessage;
  }>());
  const replyRequestsRef = useRef(new Set<string>());
  const outboxRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outboxRetryDelayRef = useRef(2_000);

  const markNewMessage = useCallback((message: Message) => {
    const identity = messageIdentity(message);
    newMessageIdsRef.current.add(identity);
    setTimeout(() => newMessageIdsRef.current.delete(identity), 1_000);
  }, []);

  const conversationId = route.params.conversation.id;
  const title = conversation.type === 'dm'
    ? conversation.dm_display_name || conversation.dm_username || 'Direct Message'
    : conversation.name || 'Unnamed Group';
  const subtitle = conversation.type === 'dm'
    ? conversation.dm_username ? `@${conversation.dm_username}` : 'Direct Message'
    : `${conversation.member_count || members.length} member${(conversation.member_count || members.length) === 1 ? '' : 's'}`;
  const otherMember = members.find((member) => member.user_id !== user?.id);
  const currentRole = members.find((member) => member.user_id === user?.id)?.role || conversation.role || 'member';
  const isModerator = currentRole === 'owner' || currentRole === 'admin';
  const canSend = currentRole !== 'viewer';
  const canAttach = canSend && (
    conversation.type === 'dm' ||
    meetsWhoThreshold(currentRole, conversation.permissions?.who_can_send_attachments || 'everyone')
  );
  const slowmodeRemaining = isModerator
    ? 0
    : Math.max(0, Math.ceil((slowmodeUntil - Date.now()) / 1_000));

  useEffect(() => {
    setActiveConversation(conversation);
    return () => setActiveConversation(null);
  }, [conversation.id, conversation.public_id, setActiveConversation]);

  const loadInitial = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    initialDataReadyGenerationRef.current = null;
    setInitialLoading(true);
    setInitialDataReady(false);
    setLoadError(null);
    try {
      const [history, detail, queued] = await Promise.all([
        chatService.messages(conversationId),
        chatService.conversation(conversationId),
        user ? outbox.list(user.id, conversationId) : Promise.resolve([]),
      ]);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      const queuedRows = user ? queued.map((job) => {
        jobsRef.current.set(job.clientId, job);
        return queuedMessage(job, user.id);
      }) : [];
      const detailMembers = detail.conversation.members || [];
      const fence = historyFenceFor(detail.conversation, detailMembers, user?.id);
      const visibleHistory = filterHistoryAtFence(history.messages, fence);
      historyFenceRef.current = fence;
      setMessages((current) => {
        const currentConversationMessages = current.filter((message) =>
          conversationMatches(message, detail.conversation));
        const visibleCurrentMessages = filterHistoryAtFence(
          currentConversationMessages.filter((message) => !message.local_status),
          fence,
        ).messages;
        const localCurrentMessages = currentConversationMessages.filter((message) =>
          Boolean(message.local_status));
        return dedupeMessages([
          ...visibleHistory.messages,
          ...queuedRows,
          ...visibleCurrentMessages,
          ...localCurrentMessages,
        ]);
      });
      setHasMore(history.hasMore && !visibleHistory.reachedFence);
      setConversation(detail.conversation);
      setMembers(detailMembers);
      initialDataReadyGenerationRef.current = generation;
      setInitialDataReady(true);
      patchConversation({ ...detail.conversation, unread_count: 0 });
    } catch (caught) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setLoadError(caught instanceof Error ? caught.message : 'Could not load messages.');
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) setInitialLoading(false);
    }
  }, [conversationId, patchConversation, user]);

  useEffect(() => {
    mountedRef.current = true;
    setConversation(route.params.conversation);
    setMessages([]);
    newMessageIdsRef.current.clear();
    localOutputIdsRef.current.clear();
    replyRequestsRef.current.clear();
    seenReactionEventsRef.current.clear();
    historyFenceRef.current = null;
    pendingResumeRefreshGenerationRef.current = null;
    initialDataReadyGenerationRef.current = null;
    setMembers([]);
    setHasMore(true);
    setOlderLoading(false);
    setInitialDataReady(false);
    setReplyTo(null);
    setEditing(null);
    void loadInitial();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      if (outboxRetryTimerRef.current) clearTimeout(outboxRetryTimerRef.current);
      outboxRetryTimerRef.current = null;
      outboxRetryDelayRef.current = 2_000;
    };
  }, [loadInitial, route.params.conversation.id]);

  useEffect(() => {
    if (slowmodeUntil <= Date.now()) return;
    const timer = setInterval(() => setClock((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [slowmodeUntil]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([, expires]) => expires > now));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const newest = messages.find((message) => !message.local_status && message.message_id);
    if (!newest || newest.message_id === lastReadRef.current) return;
    lastReadRef.current = newest.message_id;
    void chatService.markRead(conversationId, newest.message_id).catch(() => {
      lastReadRef.current = null;
    });
    patchConversation({ ...conversation, unread_count: 0, last_read_message_id: newest.message_id });
  }, [conversation, conversationId, messages, patchConversation]);

  useEffect(() => {
    const generation = loadGenerationRef.current;
    if (initialDataReadyGenerationRef.current !== generation) return;
    const historyFence = historyFenceRef.current;
    const loadedIds = new Set(messages.map((message) => message.message_id));
    const missingReplyIds = Array.from(new Set(messages
      .filter((message) => message.reply_to && !message.reply_message && !loadedIds.has(message.reply_to))
      .map((message) => message.reply_to as string)))
      .filter((messageId) => !replyRequestsRef.current.has(messageId));

    missingReplyIds.forEach((messageId) => {
      replyRequestsRef.current.add(messageId);
      void chatService.message(conversationId, messageId).then((parent) => {
        if (!mountedRef.current || generation !== loadGenerationRef.current) {
          replyRequestsRef.current.delete(messageId);
          return;
        }
        if (!filterHistoryAtFence([parent], historyFence).messages.length) return;
        setMessages((current) => current.map((message) => message.reply_to === messageId
          ? { ...message, reply_message: parent }
          : message));
      }).catch(() => replyRequestsRef.current.delete(messageId));
    });
  }, [conversationId, initialDataReady, messages]);

  const replaceByClientId = useCallback((clientId: string, next: Message) => {
    setMessages((current) => dedupeMessages([
      next,
      ...current.filter((message) => messageIdentity(message) !== clientId && message.message_id !== next.message_id),
    ]));
  }, []);

  const shouldQueue = useCallback((caught: unknown) => {
    if (!isOnline) return true;
    if (!(caught instanceof ApiError)) return true;
    return !caught.status || caught.status === 408 || caught.status === 425 || caught.status === 429 || caught.status >= 500;
  }, [isOnline]);

  const scheduleOutboxRetry = useCallback(() => {
    if (outboxRetryTimerRef.current) return;
    const delay = outboxRetryDelayRef.current;
    outboxRetryDelayRef.current = Math.min(delay * 2, 30_000);
    outboxRetryTimerRef.current = setTimeout(() => {
      outboxRetryTimerRef.current = null;
      if (mountedRef.current) setOutboxRetryTick((current) => current + 1);
    }, delay);
  }, []);

  const performSendJob = useCallback(async (job: OutboxJob, autoRetry = false) => {
    if (!user || processingRef.current.has(job.clientId)) return false;
    processingRef.current.add(job.clientId);
    jobsRef.current.set(job.clientId, job);
    if (!autoRetry) setComposerBusy(true);
    setMessages((current) => current.map((message) => messageIdentity(message) === job.clientId ? { ...message, local_status: 'sending' } : message));
    try {
      const uploaded = job.attachments.length
        ? await chatService.uploadAttachments(conversationId, job.attachments)
        : [];
      const sent = await chatService.sendMessage(conversationId, job.content, {
        clientMessageId: job.clientId,
        replyTo: job.replyTo,
        attachments: uploaded,
      });
      replaceByClientId(job.clientId, { ...sent, local_status: undefined });
      jobsRef.current.delete(job.clientId);
      await outbox.remove(user.id, job.clientId);
      outboxRetryDelayRef.current = 2_000;
      if (conversation.slowmode_seconds && !isModerator) {
        setSlowmodeUntil(Date.now() + conversation.slowmode_seconds * 1_000);
      }
      setReplyTo(null);
      return true;
    } catch (caught) {
      const queued = shouldQueue(caught);
      setMessages((current) => current.map((message) => messageIdentity(message) === job.clientId
        ? { ...message, local_status: queued ? 'queued' : 'failed' }
        : message));
      if (queued) {
        await outbox.upsert(job);
        if (isOnline) scheduleOutboxRetry();
        setNotice(!isOnline
          ? 'Message was queued and will retry when your connection recovers.'
          : 'Message service is having trouble. Your message was queued and will retry automatically.');
      } else {
        setNotice(caught instanceof Error ? caught.message : 'Message was not sent. Please retry it.');
      }
      return queued;
    } finally {
      processingRef.current.delete(job.clientId);
      if (!autoRetry && mountedRef.current) setComposerBusy(false);
    }
  }, [conversation.slowmode_seconds, conversationId, isModerator, isOnline, replaceByClientId, scheduleOutboxRetry, shouldQueue, user]);

  useEffect(() => {
    if (!isOnline || initialLoading) return;
    let active = true;
    if (!user) return;
    void outbox.list(user.id, conversationId).then(async (jobs) => {
      for (const job of jobs) {
        if (!active) return;
        await performSendJob(job, true);
      }
    });
    return () => {
      active = false;
    };
  }, [conversationId, initialLoading, isOnline, outboxRetryTick, performSendJob, user]);

  useEffect(() => {
    const offCreate = gateway.on('MESSAGE_CREATE', (raw) => {
      const incoming = raw as Message;
      if (!conversationMatches(incoming, conversation) || !incoming.message_id) return;
      if (!filterHistoryAtFence([incoming], historyFenceRef.current).messages.length) return;
      markNewMessage(incoming);
      setMessages((current) => dedupeMessages([incoming, ...current]));
      if (incoming.client_message_id && user) {
        jobsRef.current.delete(incoming.client_message_id);
        void outbox.remove(user.id, incoming.client_message_id);
      }
    });
    const offUpdate = gateway.on('MESSAGE_UPDATE', (raw) => {
      const update = raw as Partial<Message> & { message_id?: string };
      if (!conversationMatches(update, conversation) || !update.message_id) return;
      setMessages((current) => current.map((message) => message.message_id === update.message_id
        ? { ...message, ...update, content: update.is_deleted ? '[deleted]' : update.content ?? message.content }
        : message));
    });
    const offDelete = gateway.on('MESSAGE_DELETE', (raw) => {
      const data = raw as { conversation_id?: string; conversation_public_id?: string; message_id?: string };
      if (!conversationMatches(data, conversation) || !data.message_id) return;
      setMessages((current) => current.map((message) => message.message_id === data.message_id
        ? { ...message, is_deleted: true, content: '[deleted]', attachments: [], reactions: {}, forwarded: null }
        : message));
    });
    const offTyping = gateway.on('TYPING_START', (raw) => {
      const data = raw as { conversation_id?: string; conversation_public_id?: string; user_id?: string };
      if (!conversationMatches(data, conversation) || !data.user_id || data.user_id === user?.id) return;
      setTyping((current) => ({ ...current, [data.user_id!]: Date.now() + 4_500 }));
    });
    const handleReaction = (raw: unknown, forcedAction?: 'add' | 'remove') => {
      const event = raw as { event_id?: string; conversation_id?: string; conversation_public_id?: string; message_id?: string; emoji?: string; user_id?: string; action?: 'add' | 'remove' };
      if (!conversationMatches(event, conversation) || !event.message_id || !event.emoji) return;
      if (event.event_id) {
        if (seenReactionEventsRef.current.has(event.event_id)) return;
        seenReactionEventsRef.current.add(event.event_id);
        if (seenReactionEventsRef.current.size > 500) {
          const oldest = seenReactionEventsRef.current.values().next().value;
          if (oldest) seenReactionEventsRef.current.delete(oldest);
        }
      }
      const key = `${event.message_id}:${event.emoji}`;
      if (event.user_id === user?.id && (pendingOwnReactionRef.current.get(key) || 0) > Date.now()) return;
      setMessages((current) => current.map((message) => message.message_id === event.message_id
        ? applyReactionEvent(message, { emoji: event.emoji!, user_id: event.user_id, action: forcedAction || event.action || 'add' }, user?.id)
        : message));
    };
    const offReactionAdd = gateway.on('REACTION_ADD', (raw) => handleReaction(raw, 'add'));
    const offReactionRemove = gateway.on('REACTION_REMOVE', (raw) => handleReaction(raw, 'remove'));
    const offReactionBatch = gateway.on('REACTIONS_BATCH', (raw) => {
      const data = raw as { conversation_id?: string; conversation_public_id?: string; message_id?: string; events?: unknown[] };
      if (!conversationMatches(data, conversation)) return;
      data.events?.forEach((event) => handleReaction({
        ...(event as Record<string, unknown>),
        conversation_id: data.conversation_id,
        conversation_public_id: data.conversation_public_id,
        message_id: data.message_id,
      }));
    });
    const refreshAfterResume = () => {
      const generation = loadGenerationRef.current;
      if (initialDataReadyGenerationRef.current !== generation) {
        pendingResumeRefreshGenerationRef.current = generation;
        return;
      }
      pendingResumeRefreshGenerationRef.current = null;
      const historyFence = historyFenceRef.current;
      void chatService.messages(conversationId).then((history) => {
        if (!mountedRef.current || generation !== loadGenerationRef.current) return;
        const visibleHistory = filterHistoryAtFence(history.messages, historyFence);
        setMessages((current) => dedupeMessages([...visibleHistory.messages, ...current]));
        if (visibleHistory.reachedFence) setHasMore(false);
      }).catch(() => undefined);
    };
    const offReady = gateway.on('READY', refreshAfterResume);
    const offResumed = gateway.on('RESUMED', refreshAfterResume);
    const offConversation = gateway.on('CONVERSATION_UPDATE', (raw) => {
      const data = raw as Conversation | { conversation?: Conversation };
      const next = (data as { conversation?: Conversation }).conversation || data as Conversation;
      if (!next || (next.id !== conversation.id && next.public_id !== conversation.public_id)) return;
      setConversation((current) => {
        const merged = { ...current, ...next };
        patchConversation(merged);
        return merged;
      });
    });
    const handleRemoval = (raw: unknown) => {
      const data = raw as { conversation_id?: string; conversation_public_id?: string; user_id?: string };
      if (!conversationMatches(data, conversation) || (data.user_id && data.user_id !== user?.id)) return;
      removeConversation(conversation.id);
      Alert.alert('Conversation unavailable', conversation.type === 'group' ? 'You are no longer a member of this group.' : 'This direct message was closed.');
      navigation.goBack();
    };
    const offMemberLeave = gateway.on('MEMBER_LEAVE', handleRemoval);
    const offDmHidden = gateway.on('DM_HIDDEN', handleRemoval);
    if (
      initialDataReadyGenerationRef.current === loadGenerationRef.current &&
      pendingResumeRefreshGenerationRef.current === loadGenerationRef.current
    ) {
      refreshAfterResume();
    }
    return () => {
      offCreate();
      offUpdate();
      offDelete();
      offTyping();
      offReactionAdd();
      offReactionRemove();
      offReactionBatch();
      offReady();
      offResumed();
      offConversation();
      offMemberLeave();
      offDmHidden();
    };
  }, [conversation, conversationId, initialDataReady, initialLoading, markNewMessage, navigation, patchConversation, removeConversation, user?.id]);

  const loadOlder = async () => {
    if (!hasMore || olderLoading || initialLoading || !messages.length) return;
    const generation = loadGenerationRef.current;
    const oldest = [...messages].reverse().find((message) => !message.local_status);
    if (!oldest) return;
    setOlderLoading(true);
    try {
      const page = await chatService.messages(conversationId, oldest.message_id);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      const visibleHistory = filterHistoryAtFence(page.messages, historyFenceRef.current);
      setMessages((current) => dedupeMessages([...current, ...visibleHistory.messages]));
      setHasMore(page.hasMore && !visibleHistory.reachedFence);
    } catch (caught) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setNotice(caught instanceof Error ? caught.message : 'Could not load older messages.');
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setOlderLoading(false);
      }
    }
  };

  const sendFromComposer = async (content: string, attachments: PickedAttachment[]) => {
    if (!user || !canSend) return false;
    if (attachments.length && !canAttach) {
      setNotice('Your role does not have permission to send attachments in this group.');
      return false;
    }
    if (editing) {
      setComposerBusy(true);
      try {
        await chatService.editMessage(conversationId, editing, content);
        setMessages((current) => current.map((message) => message.message_id === editing.message_id
          ? { ...message, content, is_edited: true, edited_at: new Date().toISOString() }
          : message));
        setEditing(null);
        return true;
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : 'Could not edit message.');
        return false;
      } finally {
        setComposerBusy(false);
      }
    }

    const clientId = `native-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const job: OutboxJob = {
      userId: user.id,
      clientId,
      conversationId,
      content,
      attachments,
      replyTo: replyTo?.message_id || null,
      createdAt: new Date().toISOString(),
    };
    jobsRef.current.set(clientId, job);
    const local = queuedMessage(job, user.id);
    local.local_status = 'sending';
    local.reply_message = replyTo;
    markNewMessage(local);
    const localIdentity = messageIdentity(local);
    localOutputIdsRef.current.add(localIdentity);
    setTimeout(() => localOutputIdsRef.current.delete(localIdentity), 5_000);
    setMessages((current) => dedupeMessages([local, ...current]));
    const accepted = await performSendJob(job);
    if (accepted) setReplyTo(null);
    return true;
  };

  const retryMessage = useCallback(async (message: Message) => {
    const clientId = messageIdentity(message);
    let job = jobsRef.current.get(clientId);
    if (!job && user) job = (await outbox.list(user.id, conversationId)).find((item) => item.clientId === clientId);
    if (!job) {
      setNotice('The original local attachment is no longer available.');
      return;
    }
    await performSendJob(job);
  }, [conversationId, performSendJob, user]);

  const toggleReaction = useCallback(async (message: Message, emoji: string) => {
    if (!user || message.local_status || message.is_deleted) return;
    const current = message.reactions?.[emoji]
      ? normalizeReaction(message.reactions[emoji]!, user.id)
      : { count: 0, me: false };
    const uniqueCount = Object.values(message.reactions || {}).filter((value) => normalizeReaction(value as ReactionValue, user.id).count > 0).length;
    if (!current.me && current.count === 0 && uniqueCount >= MAX_REACTIONS) {
      Alert.alert('Reaction limit reached', 'A message can have up to 10 unique reactions.');
      return;
    }
    const predictedAction = current.me ? 'remove' : 'add';
    setMessages((items) => items.map((item) => item.message_id === message.message_id
      ? applyReactionEvent(item, { emoji, user_id: user.id, action: predictedAction }, user.id)
      : item));
    const key = `${message.message_id}:${emoji}`;
    pendingOwnReactionRef.current.set(key, Date.now() + 5_000);
    try {
      const result = await chatService.toggleReaction(conversationId, message.message_id, emoji);
      if (result.action !== predictedAction) {
        setMessages((items) => items.map((item) => item.message_id === message.message_id
          ? applyReactionEvent(
              applyReactionEvent(item, {
                emoji,
                user_id: user.id,
                action: predictedAction === 'add' ? 'remove' : 'add',
              }, user.id),
              { emoji, user_id: user.id, action: result.action },
              user.id,
            )
          : item));
      }
      setTimeout(() => pendingOwnReactionRef.current.delete(key), 5_000);
    } catch (caught) {
      pendingOwnReactionRef.current.delete(key);
      setMessages((items) => items.map((item) => item.message_id === message.message_id
        ? applyReactionEvent(item, { emoji, user_id: user.id, action: predictedAction === 'add' ? 'remove' : 'add' }, user.id)
        : item));
      setNotice(caught instanceof Error ? caught.message : 'Could not update reaction.');
    }
  }, [conversationId, user]);

  const deleteSelected = async (message: Message) => {
    setActionMessage(null);
    try {
      await chatService.deleteMessage(conversationId, message.message_id);
      setMessages((current) => current.map((item) => item.message_id === message.message_id
        ? { ...item, is_deleted: true, content: '[deleted]', attachments: [], reactions: {}, forwarded: null }
        : item));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not delete message.');
    }
  };

  const openAttachment = useCallback((attachment: Attachment) => {
    const resolved = { ...attachment, url: fullUrl(attachment.url || attachment.fallback_url || '') };
    if (isImage(resolved)) {
      setSelectedAttachment(resolved);
      return;
    }
    Alert.alert(attachment.name || 'Attachment', 'Open this file with another app?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open', onPress: () => void Linking.openURL(resolved.url) },
    ]);
  }, []);

  const startAction = useCallback((message: Message) => {
    Vibration.vibrate(20);
    setActionMessage(message);
  }, []);

  const forwardMessage = async (target: Conversation) => {
    if (!forwarding || !user) return;
    setForwardBusyId(target.id);
    try {
      const picked = (forwarding.attachments || []).map((raw, index): PickedAttachment => {
        const attachment = parseAttachment(raw);
        return {
          uri: fullUrl(attachment.url || attachment.fallback_url || ''),
          name: attachment.name || `forwarded-attachment-${index + 1}`,
          mime: attachment.mime || 'application/octet-stream',
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          spoiler: attachment.spoiler,
        };
      });
      const uploaded = picked.length ? await chatService.uploadAttachments(target.id, picked) : [];
      await chatService.sendMessage(target.id, forwarding.content, {
        clientMessageId: `forward-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        attachments: uploaded,
        messageType: 'forwarded',
        forwarded: {
          original_message_id: forwarding.message_id,
          original_sender_id: forwarding.sender_id,
          original_sender_name: forwarding.sender_name || forwarding.sender_username || null,
          original_conversation_id: conversation.id,
          original_conversation_name: title,
        },
      });
      setForwarding(null);
      setForwardSearch('');
      setNotice('Message forwarded.');
    } catch (caught) {
      Alert.alert('Forward failed', caught instanceof Error ? caught.message : 'Please try again.');
    } finally {
      setForwardBusyId(null);
    }
  };

  const typingNames = Object.entries(typing)
    .filter(([, expires]) => expires > Date.now())
    .map(([userId]) => {
      const member = members.find((item) => item.user_id === userId);
      return member?.nickname || member?.display_name || member?.username || 'Someone';
    });
  const forwardTargets = useMemo(() => conversations.filter((item) => {
    const name = item.type === 'dm' ? item.dm_display_name || item.dm_username || '' : item.name || '';
    return name.toLowerCase().includes(forwardSearch.trim().toLowerCase());
  }), [conversations, forwardSearch]);

  const chronologicalSourceMessages = useMemo(
    () => [...messages].reverse(),
    [messages],
  );
  const sourceMessageById = useMemo(
    () => new Map(messages.map((message) => [messageIdentity(message), message])),
    [messages],
  );
  const sourceMessageByServerId = useMemo(
    () => new Map(messages.map((message) => [message.message_id, message])),
    [messages],
  );
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.user_id, member])),
    [members],
  );
  const timelineMessages = useMemo<TimelineMessage[]>(
    () => chronologicalSourceMessages.map((message, index) => {
      const member = memberById.get(message.sender_id);
      const older = chronologicalSourceMessages[index - 1];
      const replyTarget = message.reply_to
        ? sourceMessageByServerId.get(message.reply_to)
        : undefined;
      const context = JSON.stringify([
        member?.nickname,
        member?.display_name,
        member?.username,
        older ? messageIdentity(older) : null,
        older?.sender_id,
        older?.message_type,
        older?.reply_to,
        older?.created_at,
        replyTarget?.message_id,
        replyTarget?.content,
        replyTarget?.is_deleted,
        replyTarget?.attachments,
        replyTarget?.sender_name,
        replyTarget?.sender_username,
        density,
        messageSpacing,
        chatFontScale,
      ]);
      const cached = timelineMessageCacheRef.current.get(message);
      if (cached?.context === context) return cached.value;

      const imageAttachment = (message.attachments || [])
        .map(parseAttachment)
        .find(isImage);

      const value: TimelineMessage = {
        id: messageIdentity(message),
        senderId: message.sender_id,
        senderName: message.sender_name || member?.nickname || member?.display_name || member?.username || 'Unknown',
        createdAt: message.created_at,
        text: message.content,
        image: imageAttachment
          ? {
              uri: fullUrl(imageAttachment.url || imageAttachment.fallback_url || ''),
              width: imageAttachment.width,
              height: imageAttachment.height,
            }
          : undefined,
        status: message.local_status,
        itemType: message.message_type === 'system'
          ? 'system'
          : message.attachments?.length
            ? 'attachment'
            : 'message',
        layoutVersion: JSON.stringify([
          message.content,
          message.is_deleted,
          message.is_edited,
          message.attachments,
          message.reply_to,
          message.reply_message?.message_id,
          message.reply_message?.content,
          message.reactions,
          message.forwarded,
          message.local_status,
          context,
        ]),
      };
      timelineMessageCacheRef.current.set(message, { context, value });
      return value;
    }),
    [
      chatFontScale,
      chronologicalSourceMessages,
      density,
      memberById,
      messageSpacing,
      sourceMessageByServerId,
    ],
  );
  const rowRenderContextRef = useRef({
    chatFontScale,
    chronologicalSourceMessages,
    density,
    memberById,
    messageSpacing,
    sourceMessageById,
    sourceMessageByServerId,
    userId: user?.id,
  });
  rowRenderContextRef.current = {
    chatFontScale,
    chronologicalSourceMessages,
    density,
    memberById,
    messageSpacing,
    sourceMessageById,
    sourceMessageByServerId,
    userId: user?.id,
  };
  const timelineColors = useMemo(() => ({
    accent: palette.accent,
    background: palette.bg,
    border: palette.border,
    surface: palette.surfaceRaised,
    text: palette.text,
  }), [palette]);
  const jumpToLoadedMessage = useCallback(async (messageId: string) => {
    const target = messageListRef.current.find((message) => message.message_id === messageId);
    if (!target) {
      setNotice('That replied-to message is not loaded in this history window.');
      return;
    }
    const jumped = await timelineRef.current?.jumpToMessage(messageIdentity(target));
    if (!jumped) {
      setNotice('Could not move to that message.');
    }
  }, []);
  const shouldForceFollowOnAppend = useCallback(
    (message: TimelineMessage) => localOutputIdsRef.current.has(message.id),
    [],
  );
  const getTimelineItemType = useCallback(
    (message: TimelineMessage) => message.itemType || 'message',
    [],
  );
  const handleTimelineLoadError = useCallback((_direction: 'older' | 'newer', error: unknown) => {
    setNotice(error instanceof Error ? error.message : 'Could not update message history.');
  }, []);
  const renderTimelineMessage = useCallback(({
    message: timelineMessage,
    index,
    onHeightWillChange,
  }: TimelineRenderInfo) => {
    const {
      chatFontScale: currentFontScale,
      chronologicalSourceMessages: currentChronologicalMessages,
      density: currentDensity,
      memberById: currentMemberById,
      messageSpacing: currentMessageSpacing,
      sourceMessageById: currentSourceMessageById,
      sourceMessageByServerId: currentSourceMessageByServerId,
      userId,
    } = rowRenderContextRef.current;
    const item = currentSourceMessageById.get(timelineMessage.id);
    if (!item) return null;

    const older = currentChronologicalMessages[index - 1];
    const grouped = Boolean(
      older &&
      older.sender_id === item.sender_id &&
      older.message_type === item.message_type &&
      !item.reply_to &&
      !older.reply_to &&
      Math.abs((Date.parse(item.created_at) || 0) - (Date.parse(older.created_at) || 0)) < 5 * 60_000,
    );
    const member = currentMemberById.get(item.sender_id);
    const loadedReply = item.reply_to
      ? currentSourceMessageByServerId.get(item.reply_to)
      : undefined;
    const resolved: Message = {
      ...item,
      reply_message: loadedReply || item.reply_message || null,
      sender_name: item.sender_name || member?.nickname || member?.display_name,
      sender_username: item.sender_username || member?.username,
      sender_avatar_url: item.sender_avatar_url || member?.avatar_url,
    };

    return (
      <MessageItem
        animateEntrance={newMessageIdsRef.current.has(timelineMessage.id)}
        comfortable={currentDensity === 'comfortable'}
        currentUserId={userId}
        fontSize={currentFontScale}
        message={resolved}
        onHeightWillChange={onHeightWillChange}
        onJumpToReply={(messageId) => void jumpToLoadedMessage(messageId)}
        onLongPress={startAction}
        onOpenAttachment={openAttachment}
        onRetry={(failed) => void retryMessage(failed)}
        onToggleReaction={(target, emoji) => void toggleReaction(target, emoji)}
        showHeader={!grouped}
        spacing={currentMessageSpacing}
      />
    );
  }, [
    jumpToLoadedMessage,
    openAttachment,
    retryMessage,
    startAction,
    toggleReaction,
  ]);

  return (
    <Screen keyboard>
      <View style={[styles.header, { backgroundColor: palette.surface, borderBottomColor: palette.border }]}>
        <Pressable accessibilityLabel="Back to conversations" hitSlop={10} onPress={() => navigation.goBack()} style={styles.headerButton}>
          <ArrowLeft color={palette.muted} size={22} />
        </Pressable>
        <Pressable
          disabled={!otherMember?.profile_id}
          onPress={() => otherMember?.profile_id && navigation.navigate('FriendProfile', { profileId: otherMember.profile_id })}
          style={styles.headerIdentity}
        >
          <Avatar
            displayName={title}
            size={32}
            uri={conversation.type === 'dm' ? conversation.dm_avatar_url : conversation.icon_url}
            username={conversation.dm_username}
          />
          <View style={styles.headerText}>
            <Text numberOfLines={1} style={[styles.headerTitle, { color: palette.text }]}>{title}</Text>
            <Text numberOfLines={1} style={[styles.headerSubtitle, { color: palette.muted }]}>{subtitle}</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel="Conversation settings"
          hitSlop={10}
          onPress={() => navigation.navigate(conversation.type === 'dm' ? 'DirectSettings' : 'GroupSettings', { conversation })}
          style={styles.headerButton}
        >
          <SlidersHorizontal color={palette.muted} size={21} />
        </Pressable>
      </View>

      {!isOnline ? <FeedbackBanner kind="warning" message="You're offline. Messages will be queued until your connection recovers." /> : connectionState === 'reconnecting' ? <FeedbackBanner kind="info" message="Reconnecting to server..." /> : null}
      {notice ? <FeedbackBanner kind={notice === 'Message forwarded.' ? 'success' : 'warning'} message={notice} onDismiss={() => setNotice(null)} /> : null}

      {initialLoading ? (
        <StateView message="Preparing message history..." title="Loading messages" type="loading" />
      ) : loadError ? (
        <StateView actionLabel="Retry" message={loadError} onAction={() => void loadInitial()} title="Messages unavailable" type="error" />
      ) : !messages.length ? (
        <StateView title="No messages yet. Say something!" />
      ) : (
        <NativeMessageTimeline
          ref={timelineRef}
          colors={timelineColors}
          conversationId={conversationId}
          currentUserId={user?.id || ''}
          getItemType={getTimelineItemType}
          hasOlder={hasMore}
          initialDataReady={initialDataReady}
          loadOlder={loadOlder}
          loadingOlder={olderLoading}
          messages={timelineMessages}
          onLoadError={handleTimelineLoadError}
          renderMessage={renderTimelineMessage}
          shouldForceFollowOnAppend={shouldForceFollowOnAppend}
        />
      )}

      <View style={styles.typingWrap}>
        {typingNames.length ? <Text style={[styles.typing, { color: palette.muted }]}>{typingSentence(typingNames)}</Text> : null}
      </View>
      <MessageComposer
        busy={composerBusy}
        canAttach={canAttach}
        canSend={canSend}
        conversationName={title}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onCancelReply={() => setReplyTo(null)}
        onSend={sendFromComposer}
        onTyping={() => canSend && void chatService.typing(conversationId).catch(() => undefined)}
        replyTo={replyTo}
        restrictionReason="Your viewer role can read messages but cannot send them."
        slowmodeRemaining={slowmodeRemaining}
      />

      <Modal animationType="slide" onRequestClose={() => setActionMessage(null)} transparent visible={Boolean(actionMessage)}>
        <Pressable onPress={() => setActionMessage(null)} style={[styles.modalBackdrop, { backgroundColor: palette.overlay }]}>
          <Pressable onPress={() => undefined} style={[styles.actionSheet, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: palette.text }]}>Message actions</Text>
            <View style={styles.quickReactions}>
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  accessibilityLabel={`React ${emoji}`}
                  key={emoji}
                  onPress={() => {
                    const target = actionMessage;
                    setActionMessage(null);
                    if (target) void toggleReaction(target, emoji);
                  }}
                  style={[styles.quickReaction, { backgroundColor: palette.hover }]}
                >
                  <Text style={styles.quickEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            {actionMessage?.content && !actionMessage.is_deleted ? <SheetAction icon={<Copy size={18} />} label="Copy Text" onPress={() => { void Clipboard.setStringAsync(actionMessage.content); setActionMessage(null); }} /> : null}
            {!actionMessage?.is_deleted && !actionMessage?.local_status ? <SheetAction icon={<Reply size={18} />} label="Reply" onPress={() => { setReplyTo(actionMessage); setEditing(null); setActionMessage(null); }} /> : null}
            {!actionMessage?.is_deleted && !actionMessage?.local_status ? <SheetAction icon={<Forward size={18} />} label="Forward Message" onPress={() => { setForwarding(actionMessage); setActionMessage(null); }} /> : null}
            {actionMessage?.sender_id === user?.id && !actionMessage?.is_deleted && !actionMessage?.local_status ? <SheetAction icon={<Pencil size={18} />} label="Edit Message" onPress={() => { const target = actionMessage; if (target) setEditing(target); setReplyTo(null); setActionMessage(null); }} /> : null}
            {(actionMessage?.sender_id === user?.id || isModerator) && !actionMessage?.is_deleted && !actionMessage?.local_status ? <SheetAction danger icon={<Trash2 size={18} />} label="Delete Message" onPress={() => { const target = actionMessage; if (target) void deleteSelected(target); }} /> : null}
            <SheetAction icon={<X size={18} />} label="Cancel" onPress={() => setActionMessage(null)} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setSelectedAttachment(null)} transparent visible={Boolean(selectedAttachment)}>
        <View style={styles.viewer}>
          <View style={styles.viewerActions}>
            <Pressable accessibilityLabel="Open attachment" onPress={() => selectedAttachment && void Linking.openURL(selectedAttachment.url)} style={styles.viewerButton}><Download color="#fff" size={21} /></Pressable>
            <Pressable accessibilityLabel="Close image" onPress={() => setSelectedAttachment(null)} style={styles.viewerButton}><X color="#fff" size={23} /></Pressable>
          </View>
          {selectedAttachment ? <Image resizeMode="contain" source={{ uri: selectedAttachment.url }} style={{ height: '86%', width: '100%' }} /> : null}
        </View>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setForwarding(null)} visible={Boolean(forwarding)}>
        <View style={[styles.forwardRoot, { backgroundColor: palette.bg }]}>
          <View style={[styles.forwardHeader, { borderBottomColor: palette.border }]}>
            <View>
              <Text style={[styles.forwardTitle, { color: palette.text }]}>Forward message</Text>
              <Text style={[styles.forwardSubtitle, { color: palette.muted }]}>Pick where this message should go.</Text>
            </View>
            <Pressable accessibilityLabel="Close" onPress={() => setForwarding(null)}><X color={palette.muted} size={22} /></Pressable>
          </View>
          <View style={[styles.forwardingPreview, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[styles.forwardingLabel, { color: palette.accent }]}>Forwarding</Text>
            <Text numberOfLines={2} style={[styles.forwardingText, { color: palette.text }]}>{forwarding?.content || 'Attachment'}</Text>
          </View>
          <View style={[styles.forwardSearch, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Search color={palette.muted} size={17} />
            <TextInput onChangeText={setForwardSearch} placeholder="Search conversations" placeholderTextColor={palette.faint} style={[styles.forwardInput, { color: palette.text }]} value={forwardSearch} />
          </View>
          <FlatList
            data={forwardTargets}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<StateView compact title="No conversations matched that search." />}
            renderItem={({ item }) => {
              const name = item.type === 'dm' ? item.dm_display_name || item.dm_username || 'Direct Message' : item.name || 'Unnamed Group';
              return (
                <Pressable disabled={Boolean(forwardBusyId)} onPress={() => void forwardMessage(item)} style={[styles.forwardRow, { borderBottomColor: palette.border }]}>
                  <Avatar displayName={name} size={38} uri={item.type === 'dm' ? item.dm_avatar_url : item.icon_url} />
                  <View style={styles.forwardRowText}>
                    <Text numberOfLines={1} style={[styles.forwardName, { color: palette.text }]}>{name}</Text>
                    {item.id === conversation.id ? <Text style={[styles.currentLabel, { color: palette.accent }]}>Current</Text> : null}
                  </View>
                  {forwardBusyId === item.id ? <ActivityIndicator color={palette.accent} /> : <Check color={palette.faint} size={18} />}
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
    </Screen>
  );

  function SheetAction({ label, icon, onPress, danger = false }: { label: string; icon: React.ReactElement<{ color?: string }>; onPress: () => void; danger?: boolean }) {
    const color = danger ? palette.danger : palette.text;
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.sheetAction, { backgroundColor: pressed ? palette.hover : 'transparent' }]}>
        {React.cloneElement(icon, { color })}
        <Text style={[styles.sheetActionText, { color }]}>{label}</Text>
      </Pressable>
    );
  }
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', height: 64, paddingHorizontal: 8 },
  headerButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 },
  headerIdentity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 10, minWidth: 0 },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 17, fontWeight: '800' },
  headerSubtitle: { fontSize: 11, marginTop: 2 },
  typingWrap: { height: 19, justifyContent: 'center', paddingHorizontal: 16 },
  typing: { fontSize: 11, fontStyle: 'italic' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  actionSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, paddingBottom: 24, paddingHorizontal: 12, paddingTop: 8 },
  sheetHandle: { alignSelf: 'center', backgroundColor: '#6b7280', borderRadius: 2, height: 4, marginBottom: 12, opacity: 0.6, width: 38 },
  sheetTitle: { fontSize: 15, fontWeight: '800', marginBottom: 12, paddingHorizontal: 8 },
  quickReactions: { flexDirection: 'row', gap: 7, justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 4 },
  quickReaction: { alignItems: 'center', borderRadius: 18, height: 42, justifyContent: 'center', width: 42 },
  quickEmoji: { fontSize: 21 },
  sheetAction: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 13, minHeight: 48, paddingHorizontal: 12 },
  sheetActionText: { fontSize: 14, fontWeight: '600' },
  viewer: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.95)', flex: 1, justifyContent: 'center' },
  viewerActions: { flexDirection: 'row', gap: 8, position: 'absolute', right: 16, top: 54, zIndex: 2 },
  viewerButton: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  forwardRoot: { flex: 1, paddingTop: 50 },
  forwardHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', padding: 16 },
  forwardTitle: { fontSize: 19, fontWeight: '800' },
  forwardSubtitle: { fontSize: 12, marginTop: 3 },
  forwardingPreview: { borderRadius: 12, borderWidth: 1, margin: 12, padding: 12 },
  forwardingLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  forwardingText: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  forwardSearch: { alignItems: 'center', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12 },
  forwardInput: { flex: 1, fontSize: 14, minHeight: 44 },
  forwardRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 62, paddingHorizontal: 14 },
  forwardRowText: { flex: 1, minWidth: 0 },
  forwardName: { fontSize: 14, fontWeight: '700' },
  currentLabel: { fontSize: 10, marginTop: 2 },
});
