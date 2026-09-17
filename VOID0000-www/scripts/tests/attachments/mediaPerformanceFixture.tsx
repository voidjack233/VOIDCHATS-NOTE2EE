import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MessageItem from '../../../src/components/Chat/Messages/MessageItem';
import { useNearViewportMessages } from '../../../src/components/Chat/Messages/useNearViewportMessages';
import type { Attachment, Message } from '../../../src/Services/Chat/chatTypes';
import '../../../src/index.css';

const noop = () => {};
const reactions = {};
type FixtureRow = { id: string; attachments: Attachment[]; content?: string };
let opened: string[] = [];

export default function Fixture() {
  const [rows, setRows] = useState<FixtureRow[]>([]);
  const [density, updateDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const near = useNearViewportMessages(scroller, 'media-fixture');
  useEffect(() => {
    Object.assign(window, { mediaFixture: { render: setRows, density: updateDensity, opened: () => opened } });
    return () => { Reflect.deleteProperty(window, 'mediaFixture'); };
  }, []);
  return <div ref={setScroller} data-message-timeline style={{ height: '100vh', overflowY: 'auto', width: '100%', maxWidth: 900 }}>
    {rows.map(row => <MessageItem key={row.id} message={{
      message_id: row.id, conversation_id: 'fixture', sender_id: 'peer', content: row.content || '',
      created_at: '2026-09-01T00:00:00Z', message_type: 'text',
      attachments: row.attachments.map(a => JSON.stringify(a)), is_deleted: false, is_edited: false,
    } as Message} startsGroup showDateSeparator={false} density={density} messageGroupSpacing={16}
      metaFontSize={12} replyFontSize={12} bubbleFontSize={14} currentUserId="self" replyParent={null}
      messageReactions={reactions} formatTime={() => '12:00'} getSenderName={() => 'Media fixture'}
      getSenderUsername={() => 'fixture'} getSenderAvatarUrl={() => null} onProfileClick={noop}
      onOpenEmojiPicker={noop} onDelete={noop} onToggleReaction={noop} onReply={noop}
      onOpenImageViewer={urls => { opened = urls; }} canLoadAttachments={near.has(row.id)} />)}
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
