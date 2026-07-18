import { useCallback, useEffect, useRef, useState } from 'react';
import {
  editMessage,
  sendImageOnlyMessage,
  sendMessage,
  sendTypingStart,
  updateMessageLinkPreview,
  uploadAttachments,
  type Conversation,
  type ConversationMember,
  type LinkPreviewMetadata,
  type Message,
  type MessageMentionMetadata,
} from '../../Chat/chatService';
import {
  enqueueQueuedSend,
  isTransientMessageSendFailure,
  subscribeQueuedSendOutcomes,
} from '../../Chat/queuedSendRecovery';
import { resolveMessageMentions } from '../../Chat/messageMentions';
import { fetchLinkPreview, getFirstPreviewableUrl } from '../../Chat/linkPreviewService';
import { parseAttachment, serializeAttachment } from '../../Chat/messageAttachments';

export interface PendingAttachment {
  id: string;
  preview: string;
  url: string | null;
  name: string;
  mime: string;
  size: number;
  spoiler: boolean;
  blurhash?: string;
  uploading: boolean;
  error?: string;
  file?: File;
}

interface UseMessageInputProps {
  currentUserId?: string;
  conversation: Conversation;
  members?: ConversationMember[];
  onMessageSent: (message: Message) => void;
  shouldJumpToPresentAfterOwnSend?: () => boolean;
  onOwnMessageSentFromHistory?: (message: Message) => Promise<void> | void;
  onSendError?: (message: string | null) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (
    messageId: string,
    updates: {
      content: string;
      mentions?: MessageMentionMetadata[];
      forwarded?: Message['forwarded'];
      link_preview?: Message['link_preview'];
      message_type?: string | null;
    },
  ) => void;
}

interface AttachmentAlertState {
  title: string;
  message: string;
}

const MAX_ATTACHMENTS = 5;
const IMAGE_ACCEPT_TYPES = 'image/jpeg,image/png,image/gif,image/webp';
const MAX_ATTACHMENT_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_ATTACHMENT_PERMISSION = 'everyone';

function getSendErrorNotice(error: any): string {
  if (typeof error?.retry_after_seconds === 'number' && error.retry_after_seconds > 0) {
    return error.error || error.message || `Slowmode is active. Try again in ${error.retry_after_seconds}s.`;
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.code === 'REQUEST_TIMEOUT' || error?.name === 'AbortError' || message.toLowerCase().includes('timed out')) {
    return message || 'Message send timed out. Check your connection and retry.';
  }
  if (message.toLowerCase().includes('failed to fetch') || message.toLowerCase().includes('network')) {
    return 'Message was not sent. Check your connection and retry.';
  }
  return message || 'Message was not sent. Try again.';
}

function getQueuedSendNotice(error: any): string {
  const status = Number(error?.status ?? error?.statusCode);
  if (error?.code === 'REQUEST_TIMEOUT' || error?.name === 'AbortError') {
    return 'Message timed out and was queued. It will retry automatically.';
  }
  if (status >= 500) {
    return 'Message service is having trouble. Your message was queued and will retry automatically.';
  }
  return 'Message was queued and will retry when your connection recovers.';
}

function getAttachmentUploadErrorLabel(error: any): string {
  const status = Number(error?.status ?? error?.statusCode);
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (error?.code === 'REQUEST_TIMEOUT' || error?.name === 'AbortError' || message.includes('timed out')) return 'Upload timed out';
  if (status >= 500) return 'Service unavailable';
  if (message.includes('failed to fetch') || message.includes('network')) return 'Waiting for network';
  return 'Upload failed';
}

const resolveAttachmentAccess = (conversation: Conversation) => {
  if (conversation.type === 'dm') {
    return { allowed: true, required: DEFAULT_ATTACHMENT_PERMISSION as 'everyone' | 'admins' | 'owner' };
  }

  const required = conversation.permissions?.who_can_send_attachments ?? DEFAULT_ATTACHMENT_PERMISSION;
  const role = conversation.role;
  if (role === 'owner') return { allowed: true, required };
  if (required === 'everyone') return { allowed: role !== 'viewer', required };
  if (required === 'admins') return { allowed: role === 'admin', required };
  return { allowed: false, required };
};

export const useMessageInput = ({
  currentUserId,
  conversation,
  members,
  onMessageSent,
  shouldJumpToPresentAfterOwnSend,
  onOwnMessageSentFromHistory,
  onSendError,
  editingMessage,
  onCancelEdit,
  replyTo,
  onCancelReply,
  onEditComplete,
}: UseMessageInputProps) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [linkPreview, setLinkPreview] = useState<LinkPreviewMetadata | null>(null);
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false);
  const [dismissedLinkPreviewUrl, setDismissedLinkPreviewUrl] = useState<string | null>(null);
  const [attachmentAlert, setAttachmentAlert] = useState<AttachmentAlertState | null>(null);
  const [slowmodeRemaining, setSlowmodeRemaining] = useState(0);
  const lastTypingSentAtRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachmentAccess = resolveAttachmentAccess(conversation);
  const attachmentsAllowed = attachmentAccess.allowed;
  const attachmentsRestrictionLabel = attachmentAccess.required === 'everyone'
    ? null
    : attachmentAccess.required === 'admins' ? 'Admins' : 'Owner';
  const resolveDraftMentions = useCallback((draftText: string): MessageMentionMetadata[] => (
    conversation.type === 'group' ? resolveMessageMentions(draftText, members || []) : []
  ), [conversation.type, members]);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
  }, [text]);

  useEffect(() => {
    if (!editingMessage) return;
    setText(editingMessage.content || '');
    setLinkPreview(editingMessage.link_preview || null);
    setDismissedLinkPreviewUrl(null);
    inputRef.current?.focus();
  }, [editingMessage]);

  useEffect(() => {
    inputRef.current?.focus();
    setAttachments([]);
    setLinkPreview(null);
    setLinkPreviewLoading(false);
    setDismissedLinkPreviewUrl(null);
    setAttachmentAlert(null);
    setSlowmodeRemaining(0);
    lastTypingSentAtRef.current = 0;
  }, [conversation.id]);

  useEffect(() => {
    const previewUrl = getFirstPreviewableUrl(text);
    if (!previewUrl || previewUrl === dismissedLinkPreviewUrl) {
      setLinkPreview(null);
      setLinkPreviewLoading(false);
      return;
    }
    if (linkPreview?.url === previewUrl) {
      setLinkPreviewLoading(false);
      return;
    }

    setLinkPreview(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLinkPreviewLoading(true);
      fetchLinkPreview(previewUrl, controller.signal)
        .then((preview) => {
          if (!controller.signal.aborted) setLinkPreview(preview);
        })
        .catch(() => {
          if (!controller.signal.aborted) setLinkPreview(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLinkPreviewLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [dismissedLinkPreviewUrl, linkPreview?.url, text]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const uploadFile = useCallback(async (file: File, id: string) => {
    if (file.type.startsWith('image/')) {
      const preview = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve((event.target?.result as string) || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
      if (preview) {
        setAttachments((previous) => previous.map((attachment) => (
          attachment.id === id ? { ...attachment, preview } : attachment
        )));
      }
    }

    try {
      const [url] = await uploadAttachments(conversation.id, [file]);
      setAttachments((previous) => previous.map((attachment) => (
        attachment.id === id
          ? { ...attachment, url: url ?? null, uploading: false, error: undefined, file: undefined }
          : attachment
      )));
    } catch (error) {
      setAttachments((previous) => previous.map((attachment) => (
        attachment.id === id
          ? { ...attachment, uploading: false, error: getAttachmentUploadErrorLabel(error) }
          : attachment
      )));
    }
  }, [conversation.id]);

  const addFiles = useCallback((files: FileList | File[]) => {
    if (!attachmentsAllowed) return;
    let oversizedCount = 0;
    const accepted = Array.from(files).filter((file) => {
      if (file.size <= MAX_ATTACHMENT_FILE_SIZE) return true;
      oversizedCount += 1;
      return false;
    });
    if (oversizedCount > 0) {
      setAttachmentAlert({
        title: 'Attachment Too Large',
        message: oversizedCount === 1
          ? 'The maximum upload size is 10MB per attachment. Please choose a smaller file.'
          : `${oversizedCount} attachments were skipped because the maximum upload size is 10MB per attachment.`,
      });
    }

    const filesToAdd = accepted.slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length)).map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      preview: '',
      url: null,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      spoiler: false,
      uploading: true,
      file,
    }));
    if (filesToAdd.length === 0) return;
    setAttachments((previous) => [...previous, ...filesToAdd]);
    filesToAdd.forEach(({ id, file }) => void uploadFile(file, id));
  }, [attachments.length, attachmentsAllowed, uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
  }, []);
  const toggleAttachmentSpoiler = useCallback((id: string) => {
    setAttachments((previous) => previous.map((attachment) => (
      attachment.id === id && attachment.preview
        ? { ...attachment, spoiler: !attachment.spoiler }
        : attachment
    )));
  }, []);
  const retryAttachment = useCallback((id: string) => {
    const target = attachments.find((attachment) => attachment.id === id);
    if (!target?.file || target.uploading) return;
    setAttachments((previous) => previous.map((attachment) => (
      attachment.id === id ? { ...attachment, uploading: true, error: undefined, url: null } : attachment
    )));
    void uploadFile(target.file, id);
  }, [attachments, uploadFile]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    if (!attachmentsAllowed) return;
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }, [addFiles, attachmentsAllowed]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (attachmentsAllowed && event.target.files) addFiles(event.target.files);
    event.target.value = '';
  }, [addFiles, attachmentsAllowed]);

  const getPlaceholder = () => {
    if (!editingMessage && slowmodeRemaining > 0) return `Slowmode active: wait ${slowmodeRemaining}s`;
    if (attachments.length > 0) return 'Add a caption... (optional)';
    if (conversation.type === 'dm') return `Message ${conversation.dm_display_name || conversation.dm_username || 'user'}`;
    return `Message ${conversation.name || 'conversation'}`;
  };

  const isSlowmodeBlocked = !editingMessage && slowmodeRemaining > 0 && !['owner', 'admin'].includes(conversation.role);
  const canSend = !sending && !isSlowmodeBlocked &&
    (text.trim().length > 0 || attachments.some((attachment) => attachment.url)) &&
    !attachments.some((attachment) => attachment.uploading);

  useEffect(() => {
    if (slowmodeRemaining <= 0) return;
    const timer = window.setTimeout(() => {
      setSlowmodeRemaining((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [slowmodeRemaining]);

  useEffect(() => subscribeQueuedSendOutcomes((outcome) => {
    if (
      outcome.status === 'failed' &&
      String(outcome.record.conversation_id) === String(conversation.id)
    ) {
      onSendError?.(outcome.notice);
    }
  }), [conversation.id, onSendError]);

  useEffect(() => {
    const typingEligible = !sending && text.trim().length > 0 && !editingMessage;
    if (!typingEligible) return;
    let cancelled = false;
    const emitTyping = async () => {
      const now = Date.now();
      if (now - lastTypingSentAtRef.current < 2200) return;
      lastTypingSentAtRef.current = now;
      await sendTypingStart(conversation.id).catch(() => {});
    };
    void emitTyping();
    const timer = window.setInterval(() => {
      if (!cancelled) void emitTyping();
    }, 2200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation.id, editingMessage, sending, text]);

  const handleSend = async () => {
    if (!canSend) return;
    const trimmed = text.trim();
    const activePreviewUrl = getFirstPreviewableUrl(trimmed);
    const activeLinkPreview = activePreviewUrl && linkPreview?.url === activePreviewUrl ? linkPreview : null;
    const resolvedMentions = trimmed ? resolveDraftMentions(trimmed) : [];
    const previous = { text, attachments, linkPreview, dismissedLinkPreviewUrl };
    const uploadedAttachments = attachments.filter((attachment) => attachment.url).map((attachment) => (
      attachment.spoiler
        ? serializeAttachment({ ...parseAttachment(attachment.url!), spoiler: true })
        : attachment.url!
    ));
    const shouldCreatePendingMessage = !editingMessage && Boolean(trimmed || uploadedAttachments.length);
    const localClientId = shouldCreatePendingMessage
      ? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : null;
    const optimisticMessage: Message | null = localClientId ? {
      conversation_id: conversation.id,
      message_id: localClientId,
      sender_id: currentUserId || 'local-user',
      content: trimmed,
      message_type: 'text',
      reply_to: replyTo?.message_id || null,
      attachments: uploadedAttachments,
      is_edited: false,
      edited_at: null,
      is_deleted: false,
      created_at: new Date().toISOString(),
      reactions: {},
      link_preview: activeLinkPreview || undefined,
      mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
      local_status: 'sending',
      local_client_id: localClientId,
    } : null;
    const shouldJumpAfterOwnSend = Boolean(optimisticMessage && shouldJumpToPresentAfterOwnSend?.());
    const ownSendJumpPromise = shouldJumpAfterOwnSend && onOwnMessageSentFromHistory && optimisticMessage
      ? Promise.resolve(onOwnMessageSentFromHistory(optimisticMessage))
      : null;
    const applyOwnSendResult = async (message: Message) => {
      if (ownSendJumpPromise) {
        await ownSendJumpPromise;
      }
      onMessageSent(message);
    };

    setText('');
    setAttachments([]);
    setLinkPreview(null);
    setLinkPreviewLoading(false);
    setDismissedLinkPreviewUrl(null);
    setSending(true);
    onSendError?.(null);
    const renderedOptimisticMessage = Boolean(optimisticMessage && !shouldJumpAfterOwnSend);
    if (optimisticMessage && !shouldJumpAfterOwnSend) onMessageSent(optimisticMessage);

    try {
      if (editingMessage) {
        await editMessage(conversation.id, editingMessage.message_id, trimmed, {
          messageType: editingMessage.message_type,
          attachments: editingMessage.attachments,
          forwarded: editingMessage.forwarded,
          linkPreview: activeLinkPreview,
          mentions: resolvedMentions,
        });
        onEditComplete?.(editingMessage.message_id, {
          content: trimmed,
          mentions: resolvedMentions,
          forwarded: editingMessage.forwarded,
          link_preview: activeLinkPreview || undefined,
          message_type: editingMessage.message_type,
        });
        onCancelEdit?.();
      } else {
        const options = {
          client_message_id: localClientId || undefined,
          reply_to: replyTo?.message_id || undefined,
          attachments: uploadedAttachments,
          linkPreview: activeLinkPreview,
          mentions: resolvedMentions,
        };
        const message = trimmed
          ? await sendMessage(conversation.id, trimmed, options)
          : await sendImageOnlyMessage(conversation.id, uploadedAttachments, options);
        const sentMessage = localClientId
          ? { ...message, local_status: 'sent' as const, local_client_id: localClientId }
          : message;
        await applyOwnSendResult(sentMessage);
        onCancelReply?.();

        if (activePreviewUrl && previous.dismissedLinkPreviewUrl !== activePreviewUrl && !activeLinkPreview) {
          void fetchLinkPreview(activePreviewUrl)
            .then(async (preview) => {
              if (!preview) return;
              const update = await updateMessageLinkPreview(conversation.id, message.message_id, preview);
              onMessageSent({ ...sentMessage, ...update });
            })
            .catch((error) => console.warn('[LINK_PREVIEW] failed to attach preview after send', error));
        }
        if (conversation.slowmode_seconds && !['owner', 'admin'].includes(conversation.role)) {
          setSlowmodeRemaining(conversation.slowmode_seconds);
        }
      }
    } catch (error: any) {
      console.error('Send failed:', error);
      if (isTransientMessageSendFailure(error) && optimisticMessage && localClientId && currentUserId) {
        await applyOwnSendResult({ ...optimisticMessage, local_status: 'queued' });
        try {
          await enqueueQueuedSend({
            conversation_id: conversation.id,
            local_client_id: localClientId,
            sender_id: currentUserId,
            text: trimmed,
            uploaded_urls: uploadedAttachments,
            reply_to_id: replyTo?.message_id || null,
            link_preview: activeLinkPreview || undefined,
            mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
            created_at: optimisticMessage.created_at,
          });
          onSendError?.(getQueuedSendNotice(error));
        } catch (queueError) {
          console.error('[QUEUED_SEND] failed to persist queued send', queueError);
          await applyOwnSendResult({ ...optimisticMessage, local_status: 'failed' });
          onSendError?.('Message was not sent and could not be queued. Please retry it.');
        }
      } else {
        if (!renderedOptimisticMessage) {
          setText(previous.text);
          setAttachments(previous.attachments);
          setLinkPreview(previous.linkPreview);
          setDismissedLinkPreviewUrl(previous.dismissedLinkPreviewUrl);
        }
        if (renderedOptimisticMessage && optimisticMessage) {
          onMessageSent({ ...optimisticMessage, local_status: 'failed' });
        }
        if (typeof error?.retry_after_seconds === 'number') setSlowmodeRemaining(error.retry_after_seconds);
        onSendError?.(getSendErrorNotice(error));
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (event.key === 'Enter' && !event.shiftKey && !isMobile) {
      event.preventDefault();
      void handleSend();
    }
    if (event.key === 'Escape') {
      if (editingMessage) onCancelEdit?.();
      if (replyTo) onCancelReply?.();
    }
  };

  const handleCancelAction = () => {
    if (editingMessage) {
      onCancelEdit?.();
      setText('');
      setLinkPreview(null);
      setDismissedLinkPreviewUrl(null);
    }
    if (replyTo) onCancelReply?.();
  };

  const removeLinkPreview = () => {
    const previewUrl = linkPreview?.url || getFirstPreviewableUrl(text);
    setLinkPreview(null);
    setLinkPreviewLoading(false);
    if (previewUrl) setDismissedLinkPreviewUrl(previewUrl);
  };

  return {
    text,
    setText,
    sending,
    canSend,
    slowmodeRemaining,
    attachments,
    linkPreview,
    linkPreviewLoading,
    attachmentAlert,
    attachmentsAllowed,
    attachmentsRestrictionLabel,
    inputRef,
    mediaInputRef,
    fileInputRef,
    imageAccept: IMAGE_ACCEPT_TYPES,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction,
    handlePaste,
    openMediaPicker: () => attachmentsAllowed && mediaInputRef.current?.click(),
    openFilePicker: () => attachmentsAllowed && fileInputRef.current?.click(),
    handleFileChange,
    removeAttachment,
    toggleAttachmentSpoiler,
    retryAttachment,
    removeLinkPreview,
    dismissAttachmentAlert: () => setAttachmentAlert(null),
  };
};
