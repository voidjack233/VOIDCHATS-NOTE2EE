import type { Message } from '../../../Chat/chatService';
import type { MessageUpdate } from './messageListTypes';

const hasOwnProperty = <Key extends PropertyKey>(value: object, key: Key) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function normalizeMessageUpdate(data: Partial<Message>): MessageUpdate {
  const update: MessageUpdate = {
    message_id: String(data.message_id),
  };

  if (hasOwnProperty(data, 'content')) {
    update.content = data.is_deleted ? '[deleted]' : data.content;
  }
  if (hasOwnProperty(data, 'is_edited')) {
    update.is_edited = data.is_edited;
  }
  if (hasOwnProperty(data, 'edited_at')) {
    update.edited_at = data.edited_at;
  }
  if (hasOwnProperty(data, 'message_type')) {
    update.message_type = data.message_type;
  }
  if (hasOwnProperty(data, 'forwarded')) {
    update.forwarded = data.forwarded;
  }
  if (hasOwnProperty(data, 'mentions')) {
    update.mentions = data.mentions;
  }
  if (hasOwnProperty(data, 'link_preview')) {
    update.link_preview = data.link_preview;
  }

  return update;
}

export const applyMessageUpdate = (message: Message, messageUpdate: MessageUpdate): Message => {
  const hasContentUpdate = typeof messageUpdate.content === 'string';
  const hasIsEditedUpdate = hasOwnProperty(messageUpdate, 'is_edited');
  const hasEditedAtUpdate = hasOwnProperty(messageUpdate, 'edited_at');
  const hasForwardedUpdate = hasOwnProperty(messageUpdate, 'forwarded');
  const hasMentionsUpdate = hasOwnProperty(messageUpdate, 'mentions');
  const hasLinkPreviewUpdate = hasOwnProperty(messageUpdate, 'link_preview');
  const hasMessageTypeUpdate = hasOwnProperty(messageUpdate, 'message_type');

  return {
    ...message,
    ...(hasContentUpdate ? { content: messageUpdate.content } : {}),
    ...(hasIsEditedUpdate ? { is_edited: messageUpdate.is_edited } : {}),
    ...(hasEditedAtUpdate ? { edited_at: messageUpdate.edited_at } : {}),
    ...(hasForwardedUpdate ? { forwarded: messageUpdate.forwarded } : {}),
    ...(hasMentionsUpdate ? { mentions: messageUpdate.mentions } : {}),
    ...(hasLinkPreviewUpdate ? { link_preview: messageUpdate.link_preview } : {}),
    ...(hasMessageTypeUpdate && messageUpdate.message_type !== null
      ? { message_type: messageUpdate.message_type }
      : {}),
  };
};

export { hasOwnProperty };
