import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useReactions } from '../../../src/Services/hooks/Chats/useReactions';
import { gateway } from '../../../src/Services/Gateway/gateway';
import { setChatStorageAccount } from '../../../src/Services/Chat/chatStorageAccount';

setChatStorageAccount('user');
const messages = [{ message_id: 'message', reactions: {}, reaction_revision: '0' }];
export function Fixture() {
  const { reactions, handleToggleReaction, initReactionsFromMessages } = useReactions('conversation', gateway, 'user');
  useEffect(() => { initReactionsFromMessages(messages); }, [initReactionsFromMessages]);
  return <><button id="reaction" onClick={() => handleToggleReaction('message', 'a')}>React</button><pre id="state">{JSON.stringify(reactions)}</pre></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
