import { useState, useEffect, useCallback, useRef } from 'react';
import { setReaction } from '../../Chat/messageService';
import { ReactionSync, normalizeReactions, type ReactionSnapshot, type ReactionMap } from '../../Chat/reactionSync';
import { assertAuthOperation, captureAuthOperation } from '../../Auth/client/authOperationScope';
import type { Message } from '../../Chat/chatTypes';
import type { gateway as gatewayClient } from '../../Gateway/gateway';

export type { ReactionMap } from '../../Chat/reactionSync';
export interface ReactionData { count: number; me: boolean }
const EMPTY_REACTIONS: Record<string, ReactionMap> = {};

export const useReactions = (conversationId: string, gateway: typeof gatewayClient | undefined, currentUserId?: string, isAtPresent = true) => {
  const [snapshot, setSnapshot] = useState<{ conversationId: string; userId?: string; reactions: Record<string, ReactionMap> } | null>(null);
  const reactions = snapshot?.conversationId === conversationId && snapshot.userId === currentUserId ? snapshot.reactions : EMPTY_REACTIONS;
  const sync = useRef<ReactionSync | null>(null);
  const deferredEvents = useRef<ReactionSnapshot[]>([]);
  useEffect(() => {
    const scope = captureAuthOperation();
    const controller = new ReactionSync(conversationId, currentUserId || '', async (message, emoji, present, signal) => {
      assertAuthOperation(scope);
      return setReaction(conversationId, message, emoji, present, signal);
    }, reactions => setSnapshot({ conversationId, userId: currentUserId, reactions }), error => console.error('Failed to update reaction:', error));
    sync.current = controller; deferredEvents.current = [];
    return () => { controller.dispose(); if (sync.current === controller) sync.current = null; };
  }, [conversationId, currentUserId]);

  useEffect(() => {
    if (isAtPresent && deferredEvents.current.length) {
      sync.current?.receive(deferredEvents.current); deferredEvents.current = [];
    }
  }, [isAtPresent]);

  useEffect(() => {
    if (!gateway) return;
    const receive = (events: ReactionSnapshot[]) => {
      if (isAtPresent) sync.current?.receive(events); else deferredEvents.current.push(...events);
    };
    const individual = (event: ReactionSnapshot) => { if (event.conversation_id === conversationId) receive([event]); };
    const batch = (data: { conversation_id: string; message_id: string; events: ReactionSnapshot[] }) => {
      if (data.conversation_id !== conversationId || !Array.isArray(data.events)) return;
      // Batched entries inherit identity from their envelope, not per-item IDs.
      receive(data.events.map(event => ({ ...event, conversation_id: data.conversation_id, message_id: data.message_id })));
    };
    gateway.on('REACTION_ADD', individual); gateway.on('REACTION_REMOVE', individual); gateway.on('REACTIONS_BATCH', batch);
    return () => { gateway.off('REACTION_ADD', individual); gateway.off('REACTION_REMOVE', individual); gateway.off('REACTIONS_BATCH', batch); };
  }, [conversationId, gateway, isAtPresent]);

  const initReactionsFromMessages = useCallback((messages: Array<Pick<Message, 'message_id' | 'reactions' | 'reaction_revision'>>) => { sync.current?.seed(messages); }, []);
  const handleToggleReaction = useCallback((message: string, emoji: string) => { sync.current?.toggle(message, emoji); }, []);
  const getMessageReactions = useCallback((message: string, fallback?: Message['reactions']): ReactionMap => reactions[message] ?? normalizeReactions(fallback, currentUserId), [reactions, currentUserId]);
  return { reactions, initReactionsFromMessages, handleToggleReaction, getMessageReactions };
};
