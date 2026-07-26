// src/Services/Chat/conversationCache.ts
//
// Module-level cache for conversation details (members and DM peer info).
//
// Previously this was a useRef<Record<string, ConversationDetails>> inside
// useChatManager. Moving it here means the cache survives component remounts,
// is shared across all hook instances, and is independently testable.
//
// Entries are keyed by both `id` and `public_id` when available so that
// lookups succeed regardless of which identifier the caller has on hand.
// storeConversationDetails handles writing both keys.

import type { Conversation, ConversationDetails } from './chatTypes';

const cache = new Map<string, ConversationDetails>();
const detailRequests = new Map<string, Promise<ConversationDetails>>();
const detailRefreshedAt = new Map<string, number>();
const DEFAULT_REQUEST_SCOPE = 'default';
const REQUEST_SCOPE_SEPARATOR = '\u0000';

const getScopedRequestKey = (scope: string, identifier: string): string =>
  `${scope || DEFAULT_REQUEST_SCOPE}${REQUEST_SCOPE_SEPARATOR}${identifier}`;

const deleteFreshnessForAliases = (aliases: string[], scope?: string): void => {
  if (scope) {
    aliases.forEach((alias) => detailRefreshedAt.delete(getScopedRequestKey(scope, alias)));
    return;
  }

  for (const key of detailRefreshedAt.keys()) {
    if (aliases.some((alias) => key.endsWith(`${REQUEST_SCOPE_SEPARATOR}${alias}`))) {
      detailRefreshedAt.delete(key);
    }
  }
};

export const getConversationDetails = (
  id: string | null | undefined,
): ConversationDetails | null => {
  if (!id) return null;
  return cache.get(id) ?? null;
};

export const setConversationDetails = (
  id: string,
  entry: ConversationDetails,
): void => {
  cache.set(id, entry);
};

const deleteConversationDetailsEntry = (id: string, requestScope?: string): void => {
  const existing = getConversationDetails(id);
  cache.delete(id);
  deleteFreshnessForAliases([id], requestScope);

  if (!existing) return;

  cache.delete(existing.id);
  const aliases = [existing.id];
  if (existing.public_id) {
    cache.delete(existing.public_id);
    aliases.push(existing.public_id);
  }
  deleteFreshnessForAliases(aliases, requestScope);
};

export const deleteConversationDetails = (id: string): void => {
  deleteConversationDetailsEntry(id);
};

export const deleteScopedConversationDetails = (
  id: string,
  requestScope: string,
): void => {
  deleteConversationDetailsEntry(id, requestScope);
};

/**
 * Writes a conversation into the cache,
 * keyed by both id and public_id so lookups succeed with either identifier.
 * Returns the normalised cache entry.
 */
export const storeConversationDetails = (
  conversation: ConversationDetails,
): ConversationDetails => {
  const cacheEntry: ConversationDetails = {
    ...conversation,
    channels: conversation.channels || [],
  };

  setConversationDetails(cacheEntry.id, cacheEntry);

  if (cacheEntry.public_id) {
    setConversationDetails(cacheEntry.public_id, cacheEntry);
  }

  return cacheEntry;
};

export const storeConversationSummary = (
  conversation: Conversation,
): ConversationDetails => {
  const existing =
    getConversationDetails(conversation.id) ||
    getConversationDetails(conversation.public_id);
  const summary = conversation as ConversationDetails;

  return storeConversationDetails({
    ...(existing || {}),
    ...summary,
    members: summary.members ?? existing?.members,
    channels: summary.channels ?? existing?.channels ?? [],
  });
};

const getDetailRequestKey = (identifier: string): string => {
  const existing = getConversationDetails(identifier);
  return existing?.public_id || existing?.id || identifier;
};

const markConversationDetailsRefreshed = (
  conversation: ConversationDetails,
  requestScope: string,
): void => {
  const refreshedAt = Date.now();
  detailRefreshedAt.set(getScopedRequestKey(requestScope, conversation.id), refreshedAt);
  if (conversation.public_id) {
    detailRefreshedAt.set(
      getScopedRequestKey(requestScope, conversation.public_id),
      refreshedAt,
    );
  }
};

export const areConversationDetailsFresh = (
  identifier: string,
  maxAgeMs: number,
  requestScope = DEFAULT_REQUEST_SCOPE,
): boolean => {
  const existing = getConversationDetails(identifier);
  const refreshedAt = Math.max(
    detailRefreshedAt.get(getScopedRequestKey(requestScope, identifier)) || 0,
    existing
      ? detailRefreshedAt.get(getScopedRequestKey(requestScope, existing.id)) || 0
      : 0,
    existing?.public_id
      ? detailRefreshedAt.get(getScopedRequestKey(requestScope, existing.public_id)) || 0
      : 0,
  );

  return refreshedAt > 0 && Date.now() - refreshedAt <= maxAgeMs;
};

export const requestConversationDetails = (
  identifier: string,
  load: () => Promise<ConversationDetails>,
  requestScope = DEFAULT_REQUEST_SCOPE,
): Promise<ConversationDetails> => {
  const requestKey = getScopedRequestKey(requestScope, getDetailRequestKey(identifier));
  const existingRequest = detailRequests.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = load()
    .then((conversation) => {
      const existing =
        getConversationDetails(identifier) ||
        getConversationDetails(conversation.id) ||
        getConversationDetails(conversation.public_id);
      const stored = storeConversationDetails({
        ...(existing || {}),
        ...conversation,
        members: conversation.members ?? existing?.members,
        channels: conversation.channels ?? existing?.channels ?? [],
      });
      markConversationDetailsRefreshed(stored, requestScope);
      return stored;
    })
    .finally(() => {
      if (detailRequests.get(requestKey) === request) {
        detailRequests.delete(requestKey);
      }
    });

  detailRequests.set(requestKey, request);
  return request;
};

export const requestConversationDetailsIfStale = (
  identifier: string,
  load: () => Promise<ConversationDetails>,
  {
    maxAgeMs,
    requestScope = DEFAULT_REQUEST_SCOPE,
  }: {
    maxAgeMs: number;
    requestScope?: string;
  },
): Promise<ConversationDetails> => {
  const cachedConversation = getConversationDetails(identifier);
  if (
    cachedConversation &&
    maxAgeMs > 0 &&
    areConversationDetailsFresh(identifier, maxAgeMs, requestScope)
  ) {
    return Promise.resolve(cachedConversation);
  }

  return requestConversationDetails(identifier, load, requestScope);
};
