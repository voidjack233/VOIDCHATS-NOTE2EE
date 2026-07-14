// src/pages/Chat/Chats.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import ConversationSettings from '../../components/Chat/Conversation/ConversationSettings';
import { useAuth } from '../../Services/hooks/Auth/useAuth';
import { useProfileRecord } from '../../Services/hooks/profile/useProfileRecord';
import { useChatManager } from '../../Services/hooks/Chats/useChatManager';
import { useFriends } from '../../Services/hooks/Friends/useFriends';
import UserProfileModal from '../../components/common/Profile/UserProfileModal';
import SettingsModal from '../../components/common/Settings/SettingsModal';
import ConversationList from '../../components/Chat/Conversation/ConversationList';
import MessageView from '../../components/Chat/MessageView/MessageViewV2';
import MessageInput from '../../components/Chat/Composer/MessageInput';
import ForwardMessageModal from '../../components/Chat/Conversation/ForwardMessageModal';
import GroupCreateModal from '../../components/Chat/Groups/GroupCreateModal';
import FriendsView from '../../components/common/Friends/FriendsView';
import { gateway } from '../../Services/Gateway/gateway';
import { Message, Conversation, ConversationMember, forwardMessageToConversation } from '../../Services/Chat/chatService';
import { matchesConversationIdentifier } from '../../Services/Chat/utils/conversationUtils';
import { useUser } from '../../Services/Auth/UserContext';
import { ConversationPaneSkeleton } from '../../components/common/Skeleton';
import { useConnectionStatus } from '../../Services/hooks/common/useConnectionStatus';
import { useServiceHealth } from '../../Services/hooks/common/useServiceHealth';
import ChatSidebar from './ChatSidebar';
import ConversationHeader from './ConversationHeader';
import ChatStatusBanners from './ChatStatusBanners';

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const ChatDashboard = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    dmConversationId,
    groupConversationId,
  } = useParams<{
    dmConversationId?: string;
    groupConversationId?: string;
  }>();
  const { loading, user } = useAuth();
  const { isLoggingOut } = useUser();

  const { profile: myProfile } = useProfileRecord(user?.profile_id || '');
  const { isOnline, showReconnectBanner } = useConnectionStatus();
  const serviceHealth = useServiceHealth();
  const serviceIssue = serviceHealth.issues[0] || null;
  const showFullscreenPreparing = isLoggingOut || loading;

  // Independently detect bootstrap stalls (API down before the gateway ever
  // connects). The gateway stall timer in useConnectionStatus only fires once
  // gatewayState === 'reconnecting', which never happens if /api/me or the key
  // backup fetch hang. This timer covers that earlier failure path.
  const [bootstrapStalled, setBootstrapStalled] = useState(false);
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isBootstrapping = loading && !isLoggingOut;
    if (isBootstrapping) {
      if (!bootstrapTimerRef.current) {
        bootstrapTimerRef.current = setTimeout(() => setBootstrapStalled(true), 8000);
      }
    } else {
      if (bootstrapTimerRef.current) {
        clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
      setBootstrapStalled(false);
    }
  }, [isLoggingOut, loading]);

  // Friends from the shared FriendsProvider — single source of truth
  const { friends } = useFriends();

  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [chatFilter, setChatFilter] = useState<'dm' | 'group'>('dm');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(true);
  const [mobileSidebarMode, setMobileSidebarMode] = useState<'messages' | 'friends'>('messages');
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [chatViewportHeight, setChatViewportHeight] = useState<number | null>(() =>
    typeof window !== 'undefined'
      ? window.visualViewport?.height ?? window.innerHeight
      : null
  );
  const [convRefresh, setConvRefresh] = useState(0);
  const [lastSentConversationId, setLastSentConversationId] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const ownSendNeedsPresentJumpRef = useRef(false);
  const ownSendJumpResolversRef = useRef<Array<() => void>>([]);
  const [ownSendJumpRequest, setOwnSendJumpRequest] = useState(0);
  const [showConvSettings, setShowConvSettings] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const memberDisplayCacheRef = useRef<Record<string, ConversationMember>>({});

  const {
    members,
    activeConversation,
    activeGroup,
    typingUsers,
    messageEvents,
    editingMessage,
    replyTo,
    messageUpdate,
    messageDelete,
    setEditingMessage,
    setReplyTo,
    setMessageUpdate,
    patchConversationInState,
    handleMessageSent,
    handleStartDM,
    handleBackToMe,
    openConversationByIdentifier,
    openGroupByIdentifier,
  } = useChatManager(user);

  const showSendNotice = useCallback((message: string | null) => {
    setSendNotice(message);
  }, []);
  const handleOwnSendHistoryModeChange = useCallback((shouldJumpToPresent: boolean) => {
    ownSendNeedsPresentJumpRef.current = shouldJumpToPresent;
  }, []);
  const requestOwnSendJumpToPresent = useCallback(() => (
    new Promise<void>((resolve) => {
      ownSendJumpResolversRef.current.push(resolve);
      setOwnSendJumpRequest((request) => request + 1);
    })
  ), []);
  const handleOwnSendJumpSettled = useCallback(() => {
    const resolvers = ownSendJumpResolversRef.current;
    ownSendJumpResolversRef.current = [];
    resolvers.forEach((resolve) => resolve());
  }, []);

  useEffect(() => () => {
    const resolvers = ownSendJumpResolversRef.current;
    ownSendJumpResolversRef.current = [];
    resolvers.forEach((resolve) => resolve());
  }, []);

  useEffect(() => {
    showSendNotice(null);
  }, [activeConversation?.id, showSendNotice]);

  const getRouteId = (conversation?: { public_id?: string | null }) => conversation?.public_id || null;

  const getDmRoute = (conversation?: { public_id?: string | null }) => {
    const routeId = getRouteId(conversation);
    return routeId ? `/chats/@me/${routeId}` : '/chats';
  };

  const getGroupRoute = (group?: { public_id?: string | null }) => {
    const groupRouteId = getRouteId(group);
    if (!groupRouteId) return '/chats';
    return `/chats/${groupRouteId}`;
  };

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileSidebarOpen(true);
      return;
    }

    const hasConversationRoute = Boolean(dmConversationId || groupConversationId);
    setIsMobileSidebarOpen(!hasConversationRoute);
  }, [isMobile, dmConversationId, groupConversationId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncViewportHeight = () => {
      setChatViewportHeight(window.visualViewport?.height ?? window.innerHeight);
    };

    syncViewportHeight();
    window.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('resize', syncViewportHeight);

    return () => {
      window.removeEventListener('resize', syncViewportHeight);
      window.visualViewport?.removeEventListener('resize', syncViewportHeight);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncRouteState = async () => {
      if (loading || !user?.id) return;

      try {
        if (dmConversationId) {
          const dmAlreadyHydrated =
            !activeGroup &&
            activeConversation?.type === 'dm' &&
            matchesConversationIdentifier(activeConversation, dmConversationId);
          if (dmAlreadyHydrated) {
            return;
          }

          const conversation = await openConversationByIdentifier(dmConversationId);
          if (!cancelled && conversation?.type !== 'dm') {
            handleBackToMe();
            navigate('/chats', { replace: true });
          }
          return;
        }

        if (groupConversationId) {
          const groupMatchesRoute = matchesConversationIdentifier(activeGroup, groupConversationId);
          if (groupMatchesRoute && activeConversation?.type === 'group') {
            return;
          }

          const result = await openGroupByIdentifier(groupConversationId, null);
          if (cancelled) return;

          const normalizedRoute = getGroupRoute(result.group);
          if (normalizedRoute !== '/chats' && normalizedRoute !== location.pathname) {
            navigate(normalizedRoute, { replace: true });
          }
          return;
        }

        handleBackToMe();
      } catch (err) {
        if (cancelled) return;
        const reason = err instanceof Error ? err.message : String(err || '');
        if (!reason.includes('Not a member of this conversation')) {
          console.error('Failed to sync chat route:', err);
        }
        handleBackToMe();
        navigate('/chats', { replace: true });
      }
    };

    void syncRouteState();
    return () => {
      cancelled = true;
    };
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.type,
    activeGroup?.id,
    activeGroup?.public_id,
    loading,
    user?.id,
    dmConversationId,
    groupConversationId,
    location.pathname,
    navigate,
  ]);

  useEffect(() => {
    Object.entries(members).forEach(([userId, member]) => {
      if (!member) return;
      memberDisplayCacheRef.current[userId] = {
        ...(memberDisplayCacheRef.current[userId] || {}),
        ...member,
      };
    });
  }, [members]);


  const messageDisplayMembers = useMemo(
    () => ({
      ...memberDisplayCacheRef.current,
      ...members,
    }),
    [members, activeConversation?.id]
  );

  const handleReply = useCallback((message: Message) => {
    setReplyTo(message);
  }, [setReplyTo]);

  const handleEdit = useCallback((message: Message) => {
    setEditingMessage(message);
  }, [setEditingMessage]);

  const getMessageSenderDisplayName = useCallback((message: Message) => {
    if (message.sender_id === user?.id) {
      return myProfile?.display_name || user?.username || 'You';
    }

    const member = messageDisplayMembers[message.sender_id];
    if (member) {
      return member.nickname || member.display_name || member.username || 'Unknown';
    }

    const friend = friends.find((entry) => entry.id === message.sender_id);
    return friend?.display_name || friend?.username || 'Unknown';
  }, [friends, messageDisplayMembers, myProfile?.display_name, user?.id, user?.username]);

  const handleForward = useCallback((message: Message) => {
    setForwardingMessage(message);
  }, []);

  const handleEditComplete = useCallback((messageId: string, updates: {
    content: string;
    mentions?: Message['mentions'];
    forwarded?: Message['forwarded'];
    link_preview?: Message['link_preview'];
    message_type?: string | null;
  }) => {
    setMessageUpdate({
      message_id: messageId,
      content: updates.content,
      is_edited: true,
      edited_at: new Date().toISOString(),
      mentions: updates.mentions,
      forwarded: updates.forwarded,
      link_preview: updates.link_preview,
      message_type: updates.message_type ?? undefined,
    });
  }, [setMessageUpdate]);

  const displayConversation = activeGroup || activeConversation;
  const isPendingDmRoute = Boolean(dmConversationId) && (
    activeGroup !== null ||
    activeConversation?.type !== 'dm' ||
    !matchesConversationIdentifier(activeConversation, dmConversationId)
  );
  const isPendingGroupRoute = Boolean(groupConversationId) && (
    activeConversation?.type !== 'group' ||
    !matchesConversationIdentifier(activeConversation, groupConversationId) ||
    !matchesConversationIdentifier(activeGroup, groupConversationId)
  );
  const isConversationRoutePending = !loading && Boolean(user?.id) && (isPendingDmRoute || isPendingGroupRoute);
  const showConversationRoutePendingSkeleton = isConversationRoutePending && !activeConversation;
  const showConversationRoutePendingOverlay = isConversationRoutePending && !!activeConversation;
  const typingParticipants = useMemo(() => {
    if (!activeConversation) return [];

    return Object.entries(typingUsers)
      .filter(([typingUserId]) => typingUserId !== user?.id)
      .sort(([, a], [, b]) => b - a)
      .map(([typingUserId]) => {
        const member = messageDisplayMembers[typingUserId] || members[typingUserId];
        return {
          userId: typingUserId,
          displayName: member?.nickname || member?.display_name || member?.username || 'Someone',
          username: member?.username || null,
          avatarUrl: member?.avatar_url || null,
        };
      });
  }, [activeConversation?.id, members, messageDisplayMembers, typingUsers, user?.id]);
  const dmPeerUserId = displayConversation?.type === 'dm' ? normalizeText(displayConversation.dm_user_id) : null;
  const dmPeerUsername = displayConversation?.type === 'dm' ? normalizeText(displayConversation.dm_username) : null;
  const dmPeer = displayConversation?.type === 'dm'
    ? Object.values(members).find(
        (member: { user_id: string; display_name?: string | null; username?: string; avatar_url?: string | null }) =>
          member.user_id !== user?.id && (
            (dmPeerUserId ? member.user_id === dmPeerUserId : false) ||
            (dmPeerUsername ? normalizeText(member.username) === dmPeerUsername : false)
          )
      ) || (!dmPeerUserId && !dmPeerUsername
        ? Object.values(members).find(
            (member: { user_id: string; display_name?: string | null; username?: string; avatar_url?: string | null }) => member.user_id !== user?.id
          ) || null
        : null)
    : null;
  const dmFriend = displayConversation?.type === 'dm'
    ? friends.find((friend) =>
        (dmPeerUserId ? friend.id === dmPeerUserId : false) ||
        (dmPeerUsername ? normalizeText(friend.username) === dmPeerUsername : false)
      ) || null
    : null;
  const resolvedDmDisplayName =
    dmPeer?.nickname ||
    displayConversation?.dm_display_name ||
    dmPeer?.display_name ||
    dmFriend?.display_name ||
    dmPeer?.username ||
    dmFriend?.username ||
    displayConversation?.dm_username ||
    null;
  const resolvedDmUsername = dmPeer?.username || dmFriend?.username || displayConversation?.dm_username || null;
  const resolvedDmAvatarUrl = dmPeer?.avatar_url || dmFriend?.avatar_url || displayConversation?.dm_avatar_url || null;
  const resolvedGroupIconUrl = displayConversation?.type === 'group'
    ? displayConversation.icon_url || null
    : null;
  const conversationHeaderTitle = displayConversation?.type === 'dm'
    ? resolvedDmDisplayName || resolvedDmUsername || 'Unknown'
    : displayConversation?.name || 'Unnamed';
  const conversationHeaderSubtitle = displayConversation?.type === 'dm' && resolvedDmUsername
    ? `@${resolvedDmUsername}`
    : '';

  if (showFullscreenPreparing) {
    if (!isLoggingOut && (showReconnectBanner || bootstrapStalled)) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-void-bg-main px-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/8 bg-white/4 p-6 text-center">
            <div className="mx-auto mb-4 h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/55" />
            <p className="text-sm font-medium text-void-text">
              {isOnline ? 'Reconnecting to server...' : "You're offline"}
            </p>
            <p className="mt-1.5 text-xs text-void-text-muted">
              {isOnline
                ? 'The server is not responding yet. Retrying...'
                : 'Check your connection. The app will resume automatically.'}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-void-bg-main">
        <div className="text-lg font-medium text-void-text">
          {isLoggingOut ? 'Signing you out...' : 'Preparing...'}
        </div>
      </div>
    );
  }

  const isFriendsPaneVisible = !displayConversation;

  const openFriendsPane = () => {
    handleBackToMe();
    navigate('/chats');
    if (isMobile) {
      setMobileSidebarMode('friends');
      setIsMobileSidebarOpen(true);
    }
  };

  const openMobileMessageList = () => {
    handleBackToMe();
    navigate('/chats', { replace: true });
    setMobileSidebarMode('messages');
    setIsMobileSidebarOpen(true);
  };

  const handleForwardToConversation = async (targetConversation: Conversation) => {
    if (!forwardingMessage || !user?.id || !displayConversation) {
      throw new Error('The message could not be forwarded right now.');
    }

    const forwarded = {
      original_message_id: forwardingMessage.message_id,
      original_sender_id: forwardingMessage.sender_id,
      original_sender_name: getMessageSenderDisplayName(forwardingMessage),
      original_conversation_id: displayConversation.id,
      original_conversation_name:
        displayConversation.type === 'dm'
          ? conversationHeaderTitle
          : displayConversation.name || 'Conversation',
    };

    const forwardedMessage = await forwardMessageToConversation(
      targetConversation,
      forwardingMessage,
      {
        currentUserId: user.id,
        forwarded,
      },
    );

    if (targetConversation.id === activeConversation?.id) {
      handleMessageSent(forwardedMessage);
      setLastSentConversationId(targetConversation.id);
    }

    setConvRefresh((count) => count + 1);
    setForwardingMessage(null);
  };

  return (
    <div
      className="flex flex-col overflow-hidden bg-void-bg-main font-sans text-void-text"
      style={{
        height: chatViewportHeight ? `${chatViewportHeight}px` : '100dvh',
        maxHeight: chatViewportHeight ? `${chatViewportHeight}px` : '100dvh',
      }}
    >
      <ChatStatusBanners
        serviceIssue={serviceIssue}
        serviceIssueCount={serviceHealth.issues.length}
        notice={sendNotice}
        onDismissNotice={() => setSendNotice(null)}
      />
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
      {/* Modals */}
      {showProfile && user?.profile_id && (
        <UserProfileModal profileId={user.profile_id} onClose={() => setShowProfile(false)} />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      
      {showCreateGroup && user?.id && (
        <GroupCreateModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => {
            setShowCreateGroup(false);
            setConvRefresh((n) => n + 1);
          }}
        />
      )}
      {showConvSettings && displayConversation && user?.id && (
        <ConversationSettings
          conversation={displayConversation}
          currentUserId={user.id}
          members={Object.values(members)}
          onMessageCreated={handleMessageSent}
          onConversationUpdated={async (nextConversation) => {
            patchConversationInState(nextConversation);
            setConvRefresh((n) => n + 1);
          }}
          onMembershipChanged={() => {
            setConvRefresh((n) => n + 1);
          }}
          onConversationLeft={() => {
            setShowConvSettings(false);
            handleBackToMe();
            navigate('/chats', { replace: true });
            setConvRefresh((n) => n + 1);
          }}
          onClose={() => setShowConvSettings(false)}
        />
      )}
      <ForwardMessageModal
        isOpen={Boolean(forwardingMessage)}
        message={forwardingMessage}
        currentConversationId={displayConversation?.id}
        onClose={() => setForwardingMessage(null)}
        onForward={handleForwardToConversation}
      />

      <ChatSidebar
        isOpen={isMobileSidebarOpen}
        mobileMode={mobileSidebarMode}
        isFriendsPaneVisible={isFriendsPaneVisible}
        filter={chatFilter}
        profile={myProfile}
        username={user?.username}
        onOpenFriends={openFriendsPane}
        onSelectFilter={(filter) => {
          setMobileSidebarMode('messages');
          setChatFilter(filter);
        }}
        onShowProfile={() => setShowProfile(true)}
        onShowSettings={() => setShowSettings(true)}
      >
          {isMobile && mobileSidebarMode === 'friends' ? (
            <FriendsView
              friends={friends}
              onStartDM={(...args) => {
                void handleStartDM(...args).then((routeId) => {
                  if (routeId) navigate(`/chats/@me/${routeId}`);
                  setConvRefresh((n) => n + 1);
                  setMobileSidebarMode('messages');
                  setIsMobileSidebarOpen(false);
                });
              }}
            />
          ) : (
            <ConversationList
              activeId={activeGroup?.id || activeConversation?.id || null}
              onSelect={(conv) => {
                if (conv.type === 'dm') {
                  navigate(getDmRoute(conv));
                } else {
                  navigate(getGroupRoute(conv));
                }
                setMobileSidebarMode('messages');
                setIsMobileSidebarOpen(false);
              }}
              onCreateGroup={() => setShowCreateGroup(true)}
              filter={chatFilter}
              friends={friends}
              refreshTrigger={convRefresh}
              bumpConversationId={lastSentConversationId}
              currentUserId={user?.id || null}
            />
          )}
      </ChatSidebar>

      {/* Main Area */}
      <div className={`flex-1 flex flex-col bg-void-bg-sec min-w-0 ${!isMobileSidebarOpen ? 'flex' : 'hidden md:flex'}`}>
        {showConversationRoutePendingSkeleton ? (
          <ConversationPaneSkeleton showMobileBack density="compact" />
        ) : activeConversation ? (
          <div className="relative flex flex-1 min-h-0">
            {showConversationRoutePendingOverlay ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
                <div className="inline-flex items-center gap-2 rounded-full border border-void-bg-hover bg-void-bg-sec/92 px-3 py-1.5 text-xs font-medium text-void-text shadow-sm backdrop-blur-sm">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-void-text-muted/30 border-t-void-text-muted" />
                  Syncing conversation...
                </div>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <ConversationHeader
                type={displayConversation?.type || activeConversation.type}
                title={conversationHeaderTitle}
                subtitle={conversationHeaderSubtitle}
                dmAvatarUrl={resolvedDmAvatarUrl}
                dmDisplayName={resolvedDmDisplayName}
                dmUsername={resolvedDmUsername}
                groupIconUrl={resolvedGroupIconUrl}
                onBack={openMobileMessageList}
                onOpenSettings={() => setShowConvSettings(true)}
              />

              <>
                <MessageView
                  key={activeConversation.id}
                  conversation={activeConversation}
                  onSendNotice={showSendNotice}
                  members={messageDisplayMembers}
                  typingParticipants={typingParticipants}
                  onReply={handleReply}
                  onForward={handleForward}
                  onEdit={handleEdit}
                  messageEvents={messageEvents}
                  userAvatar={myProfile?.avatar_url || undefined}
                  gateway={gateway}
                  messageUpdate={messageUpdate}
                  messageDelete={messageDelete}
                  ownSendJumpRequest={ownSendJumpRequest}
                  onOwnSendHistoryModeChange={handleOwnSendHistoryModeChange}
                  onOwnSendJumpSettled={handleOwnSendJumpSettled}
                />
                <MessageInput
                  currentUserId={user?.id}
                  conversation={activeConversation}
                  onMessageSent={(msg) => {
                    handleMessageSent(msg);
                    if (activeConversation?.id) setLastSentConversationId(activeConversation.id);
                  }}
                  shouldJumpToPresentAfterOwnSend={() => ownSendNeedsPresentJumpRef.current}
                  onOwnMessageSentFromHistory={requestOwnSendJumpToPresent}
                  onSendError={showSendNotice}
                  editingMessage={editingMessage}
                  onCancelEdit={() => setEditingMessage(null)}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  onEditComplete={handleEditComplete}
                  members={Object.values(messageDisplayMembers)}
                />
              </>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-void-bg-sec">
            <div className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-void-bg-hover bg-void-bg-sec/95 px-4 shadow-sm supports-[backdrop-filter]:backdrop-blur md:hidden">
              <div className="flex items-center">
                <button
                  onClick={() => {
                    setMobileSidebarMode('messages');
                    setIsMobileSidebarOpen(true);
                  }}
                  className="mr-3 p-1 text-void-text-muted hover:text-void-text hover:bg-void-bg-hover rounded-md shrink-0 transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-bold">Friends</h1>
              </div>
            </div>
            
            <FriendsView
              friends={friends}
              onStartDM={(...args) => {
                void handleStartDM(...args).then((routeId) => {
                  if (routeId) navigate(`/chats/@me/${routeId}`);
                  setConvRefresh((n) => n + 1);
                });
              }}
            />

          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default ChatDashboard;
