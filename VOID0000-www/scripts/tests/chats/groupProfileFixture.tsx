import React from 'react';
import { createRoot } from 'react-dom/client';
import { UserProvider, useUser } from '../../../src/Services/Auth/UserContext';
import { FriendsProvider, useFriends } from '../../../src/Services/hooks/Friends/useFriends';
import { PresenceProvider } from '../../../src/Services/hooks/Friends/usePresence';
import { useChatManager } from '../../../src/Services/hooks/Chats/useChatManager';
import { useMessageDisplay } from '../../../src/Services/hooks/Chats/useMessageDisplay';
import { useMessageActions } from '../../../src/components/Chat/Messages/useMessageActions';
import { resolveProfileIdentity } from '../../../src/Services/Chat/profileIdentity';
import { storeConversationSummary } from '../../../src/Services/Chat/conversationCache';
import { gateway } from '../../../src/Services/Gateway/gateway';
import MessageItem from '../../../src/components/Chat/Messages/MessageItem';
import GroupConversationSettings from '../../../src/components/Chat/Groups/GroupConversationSettings';
import UserProfileModal from '../../../src/components/common/Profile/UserProfileModal';
import TypingIndicator from '../../../src/components/Chat/Messages/TypingIndicator';
import { conversation, message } from './profileFixtures';

const noop = () => {};
const reactions = {};
const group = { ...conversation, id: 'group', public_id: '456', type: 'group' as const, name: 'Group', members: undefined };
const groupMessage = { ...message, conversation_id: 'group' };

function Surfaces() {
  const { user, loading } = useUser();
  const { friends } = useFriends();
  const chat = useChatManager(user);
  const display = useMessageDisplay(chat.members);
  const actions = useMessageActions({ userId: user?.id, userProfileId: user?.profile_id,
    friends, members: chat.members, onToggleReaction: noop });
  if (loading || !user) return null;
  return <>
    <button id="open-group" onClick={() => { void chat.openGroupByIdentifier('456'); }}>Open group</button>
    <button id="leave-view" onClick={chat.handleBackToMe}>Switch away</button>
    <button id="missing-profile" onClick={() => actions.handleProfileClick('unknown-user-uuid')}>Missing profile</button>
    <button id="close-profile" onClick={() => actions.setSelectedProfileId(null)}>Close profile</button>
    <div id="friend-count">{friends.length}</div>
    {chat.activeConversation && <>
      <div id="member-id">{chat.members.peer?.profile_id}</div>
      <div id="row"><MessageItem message={groupMessage} startsGroup showDateSeparator={false}
        density="comfortable" messageGroupSpacing={16} metaFontSize={12} replyFontSize={12} bubbleFontSize={14}
        currentUserId={user.id} replyParent={null} messageReactions={reactions} {...display}
        onProfileClick={actions.handleProfileClick} onOpenEmojiPicker={noop} onDelete={noop}
        onToggleReaction={noop} onOpenImageViewer={noop} /></div>
      <div id="typing"><TypingIndicator typingParticipants={Object.keys(chat.typingUsers).map(userId => {
        const identity = resolveProfileIdentity(friends.find(friend => friend.id === userId), chat.members[userId]);
        return { userId, ...identity, displayName: identity.displayName || 'Someone' };
      })} /></div>
      <div id="settings"><GroupConversationSettings conversation={chat.activeConversation} currentUserId={user.id}
        members={Object.values(chat.members)} onClose={noop} /></div>
    </>}
    {actions.selectedProfileId && <div id="profile"><UserProfileModal profileId={actions.selectedProfileId}
      onClose={() => actions.setSelectedProfileId(null)} /></div>}
  </>;
}

export default function GroupProfileFixture() {
  return <UserProvider><FriendsProvider><PresenceProvider><Surfaces /></PresenceProvider></FriendsProvider></UserProvider>;
}

gateway.connect = noop;
storeConversationSummary(group);
const root = createRoot(document.getElementById('root')!);
root.render(<GroupProfileFixture />);
Object.assign(window, { unmountProfileFixture: () => root.unmount() });
