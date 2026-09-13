import React from 'react';
import { createRoot } from 'react-dom/client';
import { UserProvider, useUser } from '../../../src/Services/Auth/UserContext';
import { FriendsProvider, useFriends } from '../../../src/Services/hooks/Friends/useFriends';
import { PresenceProvider } from '../../../src/Services/hooks/Friends/usePresence';
import { useConversationMembers } from '../../../src/Services/hooks/Chats/useConversationMembers';
import { useMessageDisplay } from '../../../src/Services/hooks/Chats/useMessageDisplay';
import { storeConversationDetails } from '../../../src/Services/Chat/conversationCache';
import { gateway } from '../../../src/Services/Gateway/gateway';
import MessageViewHeader, { buildMessageViewHeaderIdentity } from '../../../src/components/Chat/MessageView/MessageViewHeader';
import MessageItem from '../../../src/components/Chat/Messages/MessageItem';
import DirectConversationSettings from '../../../src/components/Chat/Conversation/DirectConversationSettings';
import ConversationList from '../../../src/components/Chat/Conversation/ConversationList';
import { conversation, message } from './profileFixtures';

const noop = () => {};
const reactions = {};

function Surfaces() {
  const { user, loading } = useUser();
  const { friends, refreshFriends } = useFriends();
  const { members } = useConversationMembers({ activeConversation: conversation, activeGroup: null, userId: user?.id });
  const display = useMessageDisplay(members);
  if (loading || !user || !friends.length) return null;
  return <>
    <button id="resync" onClick={() => { void refreshFriends(); }}>Resync</button>
    <div id="friend">{friends[0].display_name}</div>
    <div id="origin"><MessageViewHeader conversation={conversation}
      headerIdentity={buildMessageViewHeaderIdentity({ conversation, members, friends, currentUserId: user.id })}
      onProfileClick={noop} /></div>
    <div id="row"><MessageItem message={message} startsGroup showDateSeparator={false}
      density="comfortable" messageGroupSpacing={16} metaFontSize={12} replyFontSize={12} bubbleFontSize={14}
      currentUserId={user.id} replyParent={null} messageReactions={reactions}
      {...display} onProfileClick={noop} onOpenEmojiPicker={noop} onDelete={noop}
      onToggleReaction={noop} onOpenImageViewer={noop} /></div>
    <div id="list" style={{ height: 500, width: 300 }}><ConversationList activeId="dm" onSelect={noop}
      onCreateGroup={noop} filter="dm" friends={friends} currentUserId={user.id} /></div>
    <div id="settings"><DirectConversationSettings conversation={conversation} currentUserId={user.id}
      members={Object.values(members)} onClose={noop} /></div>
  </>;
}

export default function ProfileSyncFixture() {
  return <UserProvider><FriendsProvider><PresenceProvider><Surfaces /></PresenceProvider></FriendsProvider></UserProvider>;
}

gateway.connect = noop;
storeConversationDetails(conversation);
const root = createRoot(document.getElementById('root')!);
root.render(<ProfileSyncFixture />);
Object.assign(window, { unmountProfileFixture: () => root.unmount() });
