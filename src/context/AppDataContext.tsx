import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { useAuth } from './AuthContext';
import { fetchBootstrap } from '../services/bootstrap';
import { chatService } from '../services/chat';
import { gateway, GatewayConnectionState } from '../services/gateway';
import { socialService } from '../services/social';
import { playNotificationSound } from '../services/notificationSound';
import { useTheme } from '../theme/ThemeContext';
import type {
  Conversation,
  Friend,
  FriendRequest,
  Message,
  PresenceStatus,
} from '../types/models';

const BOOTSTRAP_CACHE_KEY = 'void_native_bootstrap';

interface AppDataContextValue {
  conversations: Conversation[];
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  presences: Record<string, { status: PresenceStatus; lastActive: number | null }>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  connectionState: GatewayConnectionState;
  isOnline: boolean;
  refresh: () => Promise<void>;
  startDM: (userId: string) => Promise<Conversation>;
  createGroup: (name: string) => Promise<Conversation>;
  removeFriend: (friendshipId: number) => Promise<void>;
  acceptRequest: (friendshipId: number) => Promise<void>;
  rejectRequest: (friendshipId: number) => Promise<void>;
  cancelRequest: (friendshipId: number) => Promise<void>;
  sendRequest: (profileId: string) => Promise<void>;
  patchConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  setActiveConversation: (conversation: Conversation | null) => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

const sortConversations = (conversations: Conversation[]) => [...conversations].sort((a, b) => {
  const left = Date.parse(a.updated_at || a.created_at) || 0;
  const right = Date.parse(b.updated_at || b.created_at) || 0;
  return right - left;
});

export function AppDataProvider({ children }: PropsWithChildren) {
  const { user, status } = useAuth();
  const { loadRemotePreferences, messageNotificationsEnabled } = useTheme();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [presences, setPresences] = useState<AppDataContextValue['presences']>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<GatewayConnectionState>('disconnected');
  const [isOnline, setIsOnline] = useState(true);
  const conversationsRef = useRef<Conversation[]>([]);
  const messageSoundsRef = useRef(messageNotificationsEnabled);
  const activeConversationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    messageSoundsRef.current = messageNotificationsEnabled;
  }, [messageNotificationsEnabled]);

  const setActiveConversation = useCallback((conversation: Conversation | null) => {
    activeConversationIdsRef.current = new Set(
      conversation
        ? [conversation.id, conversation.public_id].filter((id): id is string => Boolean(id))
        : [],
    );
  }, []);

  useEffect(() => {
    if (user && status === 'authenticated') void loadRemotePreferences();
  }, [loadRemotePreferences, status, user]);

  const applyBootstrap = useCallback((data: Awaited<ReturnType<typeof fetchBootstrap>>) => {
    setConversations(sortConversations(data.conversations || []));
    setFriends(data.friends || []);
    setIncoming(data.friend_requests?.incoming || []);
    setOutgoing(data.friend_requests?.outgoing || []);
  }, []);

  const refresh = useCallback(async () => {
    if (!user || status !== 'authenticated') return;
    setRefreshing(true);
    setError(null);
    try {
      const data = await fetchBootstrap();
      applyBootstrap(data);
      await AsyncStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(data));
      const snapshot = await socialService.presence().catch(() => []);
      setPresences(Object.fromEntries(snapshot.map((presence) => [
        presence.user_id,
        { status: presence.status || 'offline', lastActive: presence.last_active ?? null },
      ])));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load messages');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [applyBootstrap, status, user]);

  useEffect(() => {
    if (!user || status !== 'authenticated') {
      setConversations([]);
      setFriends([]);
      setIncoming([]);
      setOutgoing([]);
      setPresences({});
      setLoading(false);
      gateway.disconnect();
      return;
    }
    let active = true;
    setLoading(true);
    void AsyncStorage.getItem(BOOTSTRAP_CACHE_KEY).then((raw) => {
      if (!active || !raw) return;
      try {
        const cached = JSON.parse(raw) as Awaited<ReturnType<typeof fetchBootstrap>>;
        if (cached.user?.id === user.id) applyBootstrap(cached);
      } catch {
        void AsyncStorage.removeItem(BOOTSTRAP_CACHE_KEY);
      }
    }).finally(() => {
      if (active) void refresh();
    });
    gateway.connect(user.id);
    return () => {
      active = false;
      gateway.disconnect();
    };
  }, [applyBootstrap, refresh, status, user]);

  useEffect(() => {
    const unsubscribeNetwork = NetInfo.addEventListener((network) => {
      const online = Boolean(network.isConnected && network.isInternetReachable !== false);
      setIsOnline(online);
      if (online && user) gateway.reconnectNow();
    });
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        gateway.setPresence('online');
        gateway.reconnectNow();
        if (user) void socialService.presence().then((snapshot) => {
          setPresences(Object.fromEntries(snapshot.map((presence) => [
            presence.user_id,
            { status: presence.status || 'offline', lastActive: presence.last_active ?? null },
          ])));
        }).catch(() => undefined);
      } else {
        gateway.setPresence('idle');
      }
    });
    return () => {
      unsubscribeNetwork();
      appStateSubscription.remove();
    };
  }, [user]);

  useEffect(() => {
    const offConnection = gateway.on('CONNECTION_STATE', (raw) => {
      const data = raw as { state?: GatewayConnectionState };
      if (data.state) setConnectionState(data.state);
    });
    const offPresence = gateway.on('PRESENCE_UPDATE', (raw) => {
      const data = raw as { user_id?: string; status?: PresenceStatus; last_active?: number };
      if (!data.user_id || !data.status) return;
      setPresences((current) => ({
        ...current,
        [data.user_id!]: { status: data.status!, lastActive: data.last_active ?? null },
      }));
    });
    const offProfile = gateway.on('PROFILE_UPDATE', (raw) => {
      const data = raw as { user_id?: string; display_name?: string; avatar_url?: string; bio?: string };
      setFriends((current) => current.map((friend) => friend.id === data.user_id ? {
        ...friend,
        display_name: data.display_name ?? friend.display_name,
        avatar_url: data.avatar_url ?? friend.avatar_url,
        bio: data.bio ?? friend.bio,
      } : friend));
    });
    const offFriendRequest = gateway.on('FRIEND_REQUEST', (raw) => {
      const data = raw as {
        friendship_id: number;
        timestamp: number;
        from: FriendRequest;
      };
      if (!data.from) return;
      const request: FriendRequest = {
        ...data.from,
        friendship_id: data.friendship_id,
        created_at: new Date(data.timestamp || Date.now()).toISOString(),
      };
      setIncoming((current) => current.some((item) => item.friendship_id === request.friendship_id)
        ? current
        : [request, ...current]);
    });
    const offFriendAccept = gateway.on('FRIEND_ACCEPT', (raw) => {
      const data = raw as { friendship_id: number; friend?: Friend };
      setIncoming((current) => current.filter((item) => item.friendship_id !== data.friendship_id));
      setOutgoing((current) => current.filter((item) => item.friendship_id !== data.friendship_id));
      if (!data.friend) return;
      setFriends((current) => current.some((item) => item.friendship_id === data.friendship_id)
        ? current
        : [{ ...data.friend!, friendship_id: data.friendship_id, friends_since: new Date().toISOString() }, ...current]);
    });
    const offFriendRemove = gateway.on('FRIEND_REMOVE', (raw) => {
      const data = raw as { friendship_id?: number };
      setFriends((current) => current.filter((item) => item.friendship_id !== data.friendship_id));
    });
    const offConversation = gateway.on('CONVERSATION_UPDATE', (raw) => {
      const data = raw as Conversation | { conversation?: Conversation };
      const next = (data as { conversation?: Conversation }).conversation || data as Conversation;
      if (!next?.id) return;
      setConversations((current) => {
        const existing = current.find((item) =>
          item.id === next.id ||
          Boolean(item.public_id && item.public_id === next.public_id),
        );
        const merged = existing ? { ...existing, ...next } : next;
        return sortConversations([
          merged,
          ...current.filter((item) => item !== existing && item.id !== next.id),
        ]);
      });
    });
    const offMessage = gateway.on('MESSAGE_CREATE', (raw) => {
      const data = raw as Message;
      if (!data.conversation_id) return;
      const matchingConversation = conversationsRef.current.find((conversation) =>
        conversation.id === data.conversation_id ||
        conversation.public_id === data.conversation_id ||
        conversation.id === data.conversation_public_id ||
        conversation.public_id === data.conversation_public_id,
      );
      const mutedUntil = Date.parse(matchingConversation?.muted_until || '');
      const isActive = activeConversationIdsRef.current.has(data.conversation_id) ||
        Boolean(data.conversation_public_id && activeConversationIdsRef.current.has(data.conversation_public_id));
      if (
        data.sender_id !== user?.id &&
        messageSoundsRef.current &&
        !isActive &&
        !(Number.isFinite(mutedUntil) && mutedUntil > Date.now())
      ) {
        void playNotificationSound().catch(() => undefined);
      }
      setConversations((current) => sortConversations(current.map((conversation) =>
        conversation.id === data.conversation_id ||
        conversation.public_id === data.conversation_id ||
        conversation.id === data.conversation_public_id ||
        conversation.public_id === data.conversation_public_id
          ? {
              ...conversation,
              updated_at: data.created_at,
              last_message_id: data.message_id,
              last_message_sender_id: data.sender_id,
              last_message_preview: data.content || (data.attachments?.length ? 'Sent an attachment' : ''),
              unread_count: data.sender_id === user?.id
                ? conversation.unread_count
                : (conversation.unread_count || 0) + 1,
            }
          : conversation,
      )));
    });
    const resync = () => void refresh();
    const offReady = gateway.on('READY', resync);
    const offResumed = gateway.on('RESUMED', resync);
    const handleConversationRemoval = (raw: unknown) => {
      const data = raw as { conversation_id?: string; conversation_public_id?: string; user_id?: string };
      if (data.user_id && data.user_id !== user?.id) return;
      setConversations((current) => current.filter((conversation) =>
        conversation.id !== data.conversation_id &&
        conversation.public_id !== data.conversation_id &&
        conversation.id !== data.conversation_public_id &&
        conversation.public_id !== data.conversation_public_id,
      ));
    };
    const offMemberLeave = gateway.on('MEMBER_LEAVE', handleConversationRemoval);
    const offDmHidden = gateway.on('DM_HIDDEN', handleConversationRemoval);
    return () => {
      offConnection();
      offPresence();
      offProfile();
      offFriendRequest();
      offFriendAccept();
      offFriendRemove();
      offConversation();
      offMessage();
      offReady();
      offResumed();
      offMemberLeave();
      offDmHidden();
    };
  }, [refresh, user?.id]);

  const patchConversation = useCallback((conversation: Conversation) => {
    setConversations((current) => {
      const existing = current.find((item) =>
        item.id === conversation.id ||
        Boolean(item.public_id && item.public_id === conversation.public_id),
      );
      return sortConversations([
        existing ? { ...existing, ...conversation } : conversation,
        ...current.filter((item) => item !== existing && item.id !== conversation.id),
      ]);
    });
  }, []);

  const removeConversation = useCallback((conversationId: string) => {
    setConversations((current) => current.filter((item) =>
      item.id !== conversationId && item.public_id !== conversationId,
    ));
  }, []);

  const startDM = useCallback(async (userId: string) => {
    const result = await chatService.getOrCreateDM(userId);
    const existing = conversations.find((conversation) =>
      conversation.id === result.conversation_id ||
      conversation.public_id === result.conversation_public_id,
    );
    if (existing) return existing;
    const detail = await chatService.conversation(result.conversation_public_id || result.conversation_id);
    patchConversation(detail.conversation);
    return detail.conversation;
  }, [conversations, patchConversation]);

  const createGroup = useCallback(async (name: string) => {
    const result = await chatService.createGroup(name, []);
    patchConversation(result.conversation);
    return result.conversation;
  }, [patchConversation]);

  const removeFriend = useCallback(async (friendshipId: number) => {
    await socialService.removeFriend(friendshipId);
    setFriends((current) => current.filter((friend) => friend.friendship_id !== friendshipId));
  }, []);

  const acceptRequest = useCallback(async (friendshipId: number) => {
    await socialService.acceptRequest(friendshipId);
    setIncoming((current) => current.filter((request) => request.friendship_id !== friendshipId));
    void refresh();
  }, [refresh]);

  const rejectRequest = useCallback(async (friendshipId: number) => {
    await socialService.rejectRequest(friendshipId);
    setIncoming((current) => current.filter((request) => request.friendship_id !== friendshipId));
  }, []);

  const cancelRequest = useCallback(async (friendshipId: number) => {
    await socialService.cancelRequest(friendshipId);
    setOutgoing((current) => current.filter((request) => request.friendship_id !== friendshipId));
  }, []);

  const sendRequest = useCallback(async (profileId: string) => {
    const result = await socialService.sendRequest(profileId);
    if (result.request) setOutgoing((current) => [result.request!, ...current]);
  }, []);

  const value = useMemo<AppDataContextValue>(() => ({
    conversations,
    friends,
    incoming,
    outgoing,
    presences,
    loading,
    refreshing,
    error,
    connectionState,
    isOnline,
    refresh,
    startDM,
    createGroup,
    removeFriend,
    acceptRequest,
    rejectRequest,
    cancelRequest,
    sendRequest,
    patchConversation,
    removeConversation,
    setActiveConversation,
  }), [
    acceptRequest,
    cancelRequest,
    connectionState,
    conversations,
    createGroup,
    error,
    friends,
    incoming,
    isOnline,
    loading,
    outgoing,
    patchConversation,
    presences,
    refresh,
    refreshing,
    rejectRequest,
    removeConversation,
    removeFriend,
    sendRequest,
    setActiveConversation,
    startDM,
  ]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error('useAppData must be used within AppDataProvider');
  return context;
}
