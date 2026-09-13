import { memo } from 'react';
import type { Conversation, ConversationMember } from '../../../Services/Chat/chatService';
import type { Friend } from '../../../Services/hooks/Friends/useFriends';
import { resolveDmIdentity } from '../../../Services/Chat/profileIdentity';
import UserAvatar from '../../common/UserAvatar';

export interface MessageViewHeaderIdentity {
  label: string;
  avatar: string | null;
  username: string | null;
  userId: string | null;
  friendsSinceLabel: string | null;
}

export function buildMessageViewHeaderIdentity(params: {
  conversation: Conversation;
  members: Record<string, ConversationMember>;
  friends: Friend[];
  currentUserId?: string;
}): MessageViewHeaderIdentity {
  const { conversation, members, friends, currentUserId } = params;
  const identity = conversation.type === 'dm'
    ? resolveDmIdentity(conversation, members, friends, currentUserId) : null;
  const friendsSinceLabel = identity?.friend?.friends_since
    ? new Date(identity.friend.friends_since).toLocaleDateString([], {
        year: 'numeric', month: 'short', day: 'numeric',
      }) : null;
  return {
    label: identity?.displayName || (conversation.type === 'dm' ? 'Direct message' : conversation.name || 'this conversation'),
    avatar: identity?.avatarUrl || null,
    username: identity?.username || null,
    userId: identity?.userId || null,
    friendsSinceLabel,
  };
}

const MessageViewHeader = memo(function MessageViewHeader({
  conversation,
  headerIdentity,
  onProfileClick,
}: {
  conversation: Conversation;
  headerIdentity: MessageViewHeaderIdentity;
  onProfileClick: (userId: string) => void;
}) {
  if (conversation.type === 'dm') {
    return (
      <div className="px-4 pt-8 pb-6">
        <div className="max-w-2xl px-5 py-5">
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => {
                if (headerIdentity.userId) {
                  onProfileClick(headerIdentity.userId);
                }
              }}
              disabled={!headerIdentity.userId}
              className="shrink-0 disabled:cursor-default"
            >
              <UserAvatar
                src={headerIdentity.avatar}
                displayName={headerIdentity.label}
                username={headerIdentity.username}
                className="h-[72px] w-[72px] rounded-full"
                fallbackClassName="text-2xl font-bold"
              />
            </button>

            <div className="min-w-0">
              <button
                type="button"
                onClick={() => {
                  if (headerIdentity.userId) {
                    onProfileClick(headerIdentity.userId);
                  }
                }}
                disabled={!headerIdentity.userId}
                className="max-w-full text-left disabled:cursor-default"
              >
                <div className="truncate text-3xl font-bold leading-tight text-void-text">
                  {headerIdentity.label}
                </div>
                {headerIdentity.username && (
                  <div className="mt-1 truncate text-xl font-medium text-void-text-muted">
                    @{headerIdentity.username}
                  </div>
                )}
              </button>

              <p className="mt-4 text-sm text-void-text-muted">
                This is the beginning of your direct message history with{' '}
                <span className="font-semibold text-void-text">{headerIdentity.label}</span>.
              </p>

              {headerIdentity.friendsSinceLabel && (
                <div className="mt-4 inline-flex items-center rounded-full border border-void-bg-hover bg-void-bg-hover/50 px-3 py-1 text-xs text-void-text-muted">
                  Friends since {headerIdentity.friendsSinceLabel}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-8 pb-6">
      <div className="max-w-lg px-4 py-3 text-center">
        <p className="text-sm text-void-text-muted">
          This is the beginning of {headerIdentity.label}.
        </p>
      </div>
    </div>
  );
});

export default MessageViewHeader;
