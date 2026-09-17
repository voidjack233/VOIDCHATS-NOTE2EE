import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MessageItem from '../../../src/components/Chat/Messages/MessageItem';
import { useMessageRowMeasurements } from '../../../src/components/Chat/MessageView/useMessageRowMeasurements';
import { estimateMessageRowHeight } from '../../../src/components/Chat/Messages/messageRowHeight';
import { getRenderedMessages, mergeIntoRenderedWindow, recordMeasuredMessageHeights, resetRuntime, setRenderedMessages } from '../../../src/Services/hooks/Chats/MessageList/messageListRuntime';
import type { Message } from '../../../src/Services/Chat/chatTypes';
import '../../../src/index.css';

const noop = () => {};
const noAnchor = () => false;
const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
  message_id: `message-${String(i).padStart(3, '0')}`, conversation_id: 'handoff', sender_id: 'peer',
  content: i % 2 ? 'Short row' : 'Long text with wrapping. '.repeat(12), message_type: 'text',
  created_at: new Date(2026, 8, 1, 0, i).toISOString(), is_deleted: false, is_edited: false,
}));

export default function Fixture() {
  const [phase, setPhase] = useState(0);
  const [runtime, setRuntime] = useState(() => resetRuntime('handoff', messages.slice(0, 20), { hasOlder: true }));
  const rows = getRenderedMessages(runtime);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const messageHeightCacheRef = useRef(new Map<string, number>());
  const falseRef = useRef(false);
  const record = useCallback((measurements: Array<{ messageId: string; height: number }>) => {
    setRuntime(current => recordMeasuredMessageHeights(current, measurements));
  }, []);
  useMessageRowMeasurements({ scrollerRef, density: 'comfortable', recordMessageHeights: record,
    restoreViewportAnchorLock: noAnchor, visualMessagesLength: rows.length,
    firstVisualMessageId: rows[0]?.message_id, lastVisualMessageId: rows.at(-1)?.message_id,
    messageHeightCacheRef, historyScrollTransactionActiveRef: falseRef, atBottomRef: falseRef, showJumpToPresentRef: falseRef });
  useEffect(() => {
    Object.assign(window, { handoff: {
      start: () => {
        // Two genuine layout commits without letting the browser run rAF between.
        flushSync(() => {
          setRuntime(current => setRenderedMessages(current, messages.slice(0, 40)));
          setPhase(1);
        });
        flushSync(() => setRuntime(current => setRenderedMessages(current, messages.slice(0, 80))));
      },
      trim: () => {
        const removed = messages.slice(0, 40);
        const heights = removed.map(m => ({ id: m.message_id,
          dom: scrollerRef.current!.querySelector(`[data-message-id="${m.message_id}"]`)!.getBoundingClientRect().height,
          cache: messageHeightCacheRef.current.get(m.message_id), runtime: runtime.heightByMessageId.get(m.message_id),
          estimate: estimateMessageRowHeight(m, 'comfortable') }));
        const result = mergeIntoRenderedWindow(runtime, messages.slice(80), { trimFrom: 'old',
          resolveHeight: m => messageHeightCacheRef.current.get(m.message_id) ?? estimateMessageRowHeight(m, 'comfortable') });
        setRuntime(result.runtime);
        return { heights, actual: heights.reduce((sum, h) => sum + h.dom, 0), accounted: result.runtime.topSpacerHeight };
      },
    } });
    return () => { Reflect.deleteProperty(window, 'handoff'); };
  }, [runtime]);
  return <div ref={scrollerRef} data-message-timeline style={{ height: 700, overflow: 'auto', width: 500 }}>
    {rows.map(message => <MessageItem key={message.message_id} message={message} startsGroup showDateSeparator={false}
      density="comfortable" messageGroupSpacing={phase ? 17 : 16.375} metaFontSize={12} replyFontSize={12} bubbleFontSize={14.25}
      currentUserId="self" replyParent={null} messageReactions={{}} formatTime={() => '12:00'} getSenderName={() => 'Fixture'}
      getSenderUsername={() => 'fixture'} getSenderAvatarUrl={() => null} onProfileClick={noop} onOpenEmojiPicker={noop}
      onDelete={noop} onToggleReaction={noop} onReply={noop} onOpenImageViewer={noop} />)}
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
