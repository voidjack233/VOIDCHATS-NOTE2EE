import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { PointerEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Forward,
  ImageOff,
  LoaderCircle,
  Maximize,
  Plus,
  Pencil,
  RefreshCcw,
  Reply,
  Smile,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Message } from '../../../Services/Chat/chatService';
import {
  getAttachmentViewerSources,
  isAttachmentDeliveryUrlUsable,
} from '../../../Services/Chat/attachmentService';
import { MAX_UNIQUE_REACTIONS_PER_MESSAGE, getUniqueReactionCount, hasActiveReactionEntry } from '../../../Services/Chat/reactionLimits';
import type { Friend } from '../../../Services/hooks/Friends/useFriends';
import FriendProfile from '../../common/Friends/FriendProfile';
import EmojiGlyph from './EmojiGlyph';
import type {
  ContextMenuState,
  EmojiPickerTarget,
  ImageViewerState,
} from './useMessageActions';

const EmojiPicker = lazy(() => import('./EmojiPicker'));
const UserProfileModal = lazy(() => import('../../common/Profile/UserProfileModal'));

interface MessageOverlaysProps {
  contextMenu: ContextMenuState | null;
  emojiPickerTarget: EmojiPickerTarget | null;
  selectedProfileId: string | null;
  selectedFriend: Friend | null;
  imageViewer: ImageViewerState | null;
  currentUserId?: string;
  onCloseContextMenu: () => void;
  onOpenEmojiPickerAtPosition: (messageId: string, position: { x: number; y: number }) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onEmojiSelect: (emoji: string) => void;
  onCloseEmojiPicker: () => void;
  onCopyMessageText: (content?: string) => Promise<void>;
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onRetryFailed?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onCloseProfile: () => void;
  onCloseFriend: () => void;
  onCloseImageViewer: () => void;
  onPreviousImage: () => void;
  onNextImage: () => void;
  onSelectImageIndex: (index: number) => void;
}

const QUICK_REACTIONS = [
  { emoji: '❤️', label: 'Heart' },
  { emoji: '😂', label: 'Haha' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '😢', label: 'Sad' },
  { emoji: '😡', label: 'Angry' },
  { emoji: '👍', label: 'Like' },
];

function messageHasUserReaction(message: Message, emoji: string, currentUserId?: string) {
  if (!currentUserId) return false;

  const reactionData = message.reactions?.[emoji];
  if (!reactionData) return false;

  if (Array.isArray(reactionData)) {
    return reactionData.includes(currentUserId);
  }

  if (typeof reactionData === 'object') {
    return Boolean(reactionData.me);
  }

  return false;
}

function messageCanAddReaction(message: Message, emoji?: string) {
  const reactions = message.reactions as Record<string, unknown> | undefined;
  const uniqueReactionCount = getUniqueReactionCount(reactions);

  if (uniqueReactionCount < MAX_UNIQUE_REACTIONS_PER_MESSAGE) {
    return true;
  }

  if (!emoji) {
    return false;
  }

  return hasActiveReactionEntry(reactions, emoji);
}

interface ImageViewerOverlayProps {
  imageViewer: ImageViewerState;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelectIndex: (index: number) => void;
}

function ImageViewerOverlay({
  imageViewer,
  onClose,
  onPrevious,
  onNext,
  onSelectIndex,
}: ImageViewerOverlayProps) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const urls = imageViewer.urls;
  const currentIndex = imageViewer.index;
  const currentAttachment = imageViewer.attachments[currentIndex];
  const viewerSources = currentAttachment
    ? getAttachmentViewerSources(currentAttachment)
    : [];
  const currentSource = viewerSources.find((source) => !failedUrls.has(source.url)) || null;
  const legacyUrl = urls[currentIndex];
  const legacyUrlUsable = Boolean(
    legacyUrl &&
    !failedUrls.has(legacyUrl) &&
    currentAttachment &&
    isAttachmentDeliveryUrlUsable(
      legacyUrl,
      legacyUrl === currentAttachment.display_url
        ? currentAttachment.display_url_expires_at
        : currentAttachment.url_expires_at,
    ),
  );
  const currentUrl = currentSource?.url || (legacyUrlUsable ? legacyUrl : null);
  const originalDownloadUrl = currentAttachment && isAttachmentDeliveryUrlUsable(
    currentAttachment.url,
    currentAttachment.url_expires_at,
  )
    ? currentAttachment.url
    : null;
  const downloadUrl = originalDownloadUrl || currentAttachment?.fallback_url?.trim() || null;
  const scale = fitScale * zoom;

  const getPanBounds = useCallback((nextScale = scale) => {
    const image = imageRef.current;
    if (!image) return { x: 0, y: 0 };

    const padding = 72;
    return {
      x: Math.max(0, (image.naturalWidth * nextScale - (window.innerWidth - padding)) / 2 + 24),
      y: Math.max(0, (image.naturalHeight * nextScale - (window.innerHeight - padding)) / 2 + 24),
    };
  }, [scale]);

  const clampPan = useCallback((nextPan: { x: number; y: number }, nextScale = scale) => {
    const bounds = getPanBounds(nextScale);
    return {
      x: Math.max(-bounds.x, Math.min(bounds.x, nextPan.x)),
      y: Math.max(-bounds.y, Math.min(bounds.y, nextPan.y)),
    };
  }, [getPanBounds, scale]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const updateZoom = useCallback((nextZoom: number, anchor?: { x: number; y: number }) => {
    const boundedZoom = Math.max(0.5, Math.min(6, nextZoom));
    const nextScale = fitScale * boundedZoom;
    setZoom(boundedZoom);
    setPan((current) => clampPan(anchor
      ? {
          x: current.x - (anchor.x - window.innerWidth / 2) * (boundedZoom / zoom - 1),
          y: current.y - (anchor.y - window.innerHeight / 2) * (boundedZoom / zoom - 1),
        }
      : current, nextScale));
  }, [clampPan, fitScale, zoom]);

  useEffect(() => {
    resetView();
    setLoadState(currentUrl ? 'loading' : 'error');
  }, [currentIndex, currentUrl, resetView]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const keepPanInBounds = () => setPan((current) => clampPan(current));
    window.addEventListener('resize', keepPanInBounds);
    return () => window.removeEventListener('resize', keepPanInBounds);
  }, [clampPan]);

  const handleMediaError = () => {
    if (!currentUrl) return;
    setFailedUrls((current) => {
      if (current.has(currentUrl)) return current;
      const next = new Set(current);
      next.add(currentUrl);
      return next;
    });
  };

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const viewportWidth = Math.max(1, window.innerWidth - 112);
    const viewportHeight = Math.max(1, window.innerHeight - 112);
    setFitScale(Math.min(1, viewportWidth / image.naturalWidth, viewportHeight / image.naturalHeight));
    setLoadState('ready');
  };

  const handlePointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (zoom <= 1 || loadState !== 'ready') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan(clampPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }));
  };

  const endDrag = (event: PointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleDownload = () => {
    if (!currentAttachment || !downloadUrl) return;

    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = currentAttachment.name || 'attachment';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-[#07090e]/95 text-void-text backdrop-blur-md"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
    >
      <div
        className="absolute right-4 top-4 z-20 flex items-center gap-2 sm:right-6 sm:top-6"
        onClick={(event) => event.stopPropagation()}
      >
        {downloadUrl ? (
          <button
            type="button"
            onClick={handleDownload}
            className="rounded-xl border border-white/10 bg-void-bg-sec/85 p-2.5 text-void-text shadow-lg transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent"
            title="Download"
          >
            <Download className="w-5 h-5" />
          </button>
        ) : null}
        <button
          onClick={onClose}
          className="rounded-xl border border-white/10 bg-void-bg-sec/85 p-2.5 text-void-text shadow-lg transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent"
          title="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {urls.length > 1 && currentIndex > 0 && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onPrevious();
          }}
          className="absolute left-3 z-20 rounded-xl border border-white/10 bg-void-bg-sec/85 p-3 text-void-text shadow-lg transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent sm:left-6"
          aria-label="Previous image"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}

      {!currentUrl || loadState === 'error' ? (
        <div className="z-10 flex max-w-xs flex-col items-center gap-3 rounded-2xl border border-white/10 bg-void-bg-sec/90 px-7 py-6 text-center shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <ImageOff className="h-8 w-8" />
          <span className="text-sm text-void-text-muted">This image could not be loaded.</span>
          <button type="button" onClick={() => { setFailedUrls(new Set()); setLoadState('loading'); }} className="rounded-lg bg-void-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110">Try again</button>
        </div>
      ) : (
        <>
          {loadState === 'loading' && <div className="absolute z-10 flex items-center gap-2 rounded-xl border border-white/10 bg-void-bg-sec/90 px-4 py-3 text-sm text-void-text-muted"><LoaderCircle className="h-4 w-4 animate-spin text-void-accent" /> Loading image</div>}
          <img
            ref={imageRef}
            src={currentUrl}
            srcSet={currentSource?.srcSet}
            sizes={currentSource?.sizes}
            alt={currentAttachment?.name || 'Chat attachment'}
            draggable={false}
            className={`max-h-none max-w-none select-none rounded-lg shadow-2xl transition-opacity duration-150 ${loadState === 'ready' ? 'opacity-100' : 'opacity-0'} ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})` }}
            onClick={(event) => event.stopPropagation()}
            onLoad={handleImageLoad}
            onError={handleMediaError}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={(event) => { event.preventDefault(); updateZoom(zoom * (event.deltaY < 0 ? 1.14 : 0.88), { x: event.clientX, y: event.clientY }); }}
          />
        </>
      )}

      {urls.length > 1 && currentIndex < urls.length - 1 && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onNext();
          }}
          className="absolute right-3 z-20 rounded-xl border border-white/10 bg-void-bg-sec/85 p-3 text-void-text shadow-lg transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent sm:right-6"
          aria-label="Next image"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-void-bg-sec/90 p-1.5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => updateZoom(zoom / 1.25)} disabled={loadState !== 'ready' || zoom <= 0.5} className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text disabled:cursor-not-allowed disabled:opacity-40" aria-label="Zoom out"><ZoomOut className="h-4 w-4" /></button>
        <button type="button" onClick={resetView} disabled={loadState !== 'ready'} className="min-w-20 rounded-lg px-2 py-2 text-xs font-semibold text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text disabled:opacity-40" aria-label="Fit image to screen"><Maximize className="mr-1 inline h-3.5 w-3.5" />Fit</button>
        <button type="button" onClick={() => updateZoom(zoom * 1.25)} disabled={loadState !== 'ready' || zoom >= 6} className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text disabled:cursor-not-allowed disabled:opacity-40" aria-label="Zoom in"><ZoomIn className="h-4 w-4" /></button>
      </div>

      {urls.length > 1 && (
        <div
          className="absolute bottom-20 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-void-bg-sec/80 px-3 py-1.5 text-xs font-medium text-void-text-muted shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <span>{currentIndex + 1} / {urls.length}</span>
          {urls.map((_, index) => (
            <button
              key={index}
              onClick={() => onSelectIndex(index)}
              className={`h-1.5 w-1.5 rounded-full transition-all ${index === currentIndex ? 'bg-void-accent scale-125' : 'bg-white/30 hover:bg-white/70'}`}
              aria-label={`View image ${index + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function MessageOverlays({
  contextMenu,
  emojiPickerTarget,
  selectedProfileId,
  selectedFriend,
  imageViewer,
  currentUserId,
  onCloseContextMenu,
  onOpenEmojiPickerAtPosition,
  onToggleReaction,
  onEmojiSelect,
  onCloseEmojiPicker,
  onCopyMessageText,
  onReply,
  onForward,
  onEdit,
  onRetryFailed,
  onDelete,
  onCloseProfile,
  onCloseFriend,
  onCloseImageViewer,
  onPreviousImage,
  onNextImage,
  onSelectImageIndex,
}: MessageOverlaysProps) {
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuVisible(false);
      return;
    }

    setContextMenuVisible(false);
    const frame = window.requestAnimationFrame(() => {
      setContextMenuVisible(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const syncViewport = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  const contextMenuIsCopyable = Boolean(
    contextMenu?.msg.content &&
    contextMenu.msg.content !== '[deleted]',
  );
  const isFailedLocalMessage = contextMenu?.msg.local_status === 'failed';
  const canForwardMessage = Boolean(
    contextMenu &&
    !isFailedLocalMessage &&
    onForward &&
    contextMenu.msg.message_type !== 'system' &&
    (
      (
        contextMenu.msg.content &&
        contextMenu.msg.content !== '[deleted]'
      ) ||
      (contextMenu.msg.attachments?.length ?? 0) > 0
    ),
  );
  const canOpenReactionPicker = contextMenu && !isFailedLocalMessage ? messageCanAddReaction(contextMenu.msg) : false;
  const desktopReactionsOnly = !isFailedLocalMessage && !isMobileViewport && contextMenu?.mode === 'reactions';
  const handleQuickReaction = (emoji: string) => {
    if (!contextMenu) return;
    if (contextMenu.msg.local_status === 'failed') return;
    if (!messageCanAddReaction(contextMenu.msg, emoji)) return;
    onToggleReaction(contextMenu.msg.message_id, emoji);
    onCloseContextMenu();
  };

  return (
    <>
      {emojiPickerTarget && (
        <Suspense fallback={null}>
          <EmojiPicker
            onSelect={onEmojiSelect}
            onClose={onCloseEmojiPicker}
            position={emojiPickerTarget.position}
          />
        </Suspense>
      )}

      {contextMenu && !contextMenu.msg.is_deleted && createPortal(
        isMobileViewport ? (
          <div className="fixed inset-0 z-[70]">
            <button
              type="button"
              aria-label="Close message actions"
              onClick={onCloseContextMenu}
              className="absolute inset-0"
            />
            <div className="absolute inset-x-0 bottom-0 flex justify-center px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-4">
              <div
                onClick={(event) => event.stopPropagation()}
                className={`flex w-full min-w-0 max-w-[min(100%,24rem)] flex-col gap-2 transition-all duration-200 ease-out ${
                  contextMenuVisible
                    ? 'translate-y-0 scale-100 opacity-100'
                    : 'translate-y-5 scale-[0.98] opacity-0'
                }`}
              >
                {!isFailedLocalMessage && (
                  <div className="overflow-x-hidden rounded-[28px] bg-void-bg-main/95 px-3 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:backdrop-blur">
                    <div className="rounded-2xl bg-void-bg-hover/35 px-1.5 py-1.5">
                      <div className="flex min-w-0 items-center justify-between gap-1 overflow-hidden">
                        {QUICK_REACTIONS.map(({ emoji, label }) => {
                          const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
                          const isDisabled = !messageCanAddReaction(contextMenu.msg, emoji);

                          return (
                            <button
                              key={emoji}
                              type="button"
                              disabled={isDisabled}
                              onClick={() => handleQuickReaction(emoji)}
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all sm:h-10 sm:w-10 ${
                                isDisabled
                                  ? 'cursor-not-allowed opacity-40'
                                  : isSelected
                                  ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                                  : 'hover:bg-void-bg-hover/80'
                              }`}
                              aria-label={label}
                              title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                            >
                              <EmojiGlyph
                                emoji={emoji}
                                className="text-[18px] sm:text-[20px]"
                                fallbackClassName="text-[18px] sm:text-[20px]"
                              />
                            </button>
                          );
                        })}

                        {canOpenReactionPicker && (
                          <button
                            type="button"
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                                x: rect.left + rect.width / 2,
                                y: rect.top,
                              });
                              onCloseContextMenu();
                            }}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80 sm:h-10 sm:w-10"
                            aria-label="Add reaction"
                            title="Add reaction"
                            style={{ WebkitTapHighlightColor: 'transparent' }}
                          >
                            <Plus className="h-5 w-5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="overflow-x-hidden rounded-[28px] bg-void-bg-main/95 px-3 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:backdrop-blur">
                  <div className="mt-0">
                    {isFailedLocalMessage && onRetryFailed && (
                      <button
                        onClick={() => {
                          onRetryFailed(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-orange-300 transition-colors hover:bg-orange-500/15 hover:text-orange-200"
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <RefreshCcw className="h-4 w-4" />
                        Retry Send
                      </button>
                    )}
                    {!isFailedLocalMessage && (
                      <button
                        disabled={!canOpenReactionPicker}
                        onClick={() => {
                          if (!canOpenReactionPicker) return;
                          onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                            x: contextMenu.x,
                            y: contextMenu.y,
                          });
                          onCloseContextMenu();
                        }}
                        className={`flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                          canOpenReactionPicker
                            ? 'text-void-text hover:bg-void-bg-hover/90'
                            : 'cursor-not-allowed text-void-text-muted/55'
                        }`}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Smile className="h-4 w-4 text-void-accent" />
                        Add Reaction
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        await onCopyMessageText(contextMenu.msg.content);
                        onCloseContextMenu();
                      }}
                      disabled={!contextMenuIsCopyable}
                      className={`flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                        contextMenuIsCopyable
                          ? 'text-void-text hover:bg-void-bg-hover/90'
                          : 'cursor-not-allowed text-void-text-muted/55'
                      }`}
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy Text
                    </button>
                    {onReply && !isFailedLocalMessage && (
                      <button
                        onClick={() => {
                          onReply(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover/90"
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Reply className="h-4 w-4" />
                        Reply
                      </button>
                    )}
                    {!isFailedLocalMessage && (
                      <button
                        disabled={!canForwardMessage}
                        onClick={() => {
                          if (!canForwardMessage || !contextMenu || !onForward) return;
                          onForward(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                          canForwardMessage
                            ? 'text-void-text hover:bg-void-bg-hover/90'
                            : 'cursor-not-allowed text-void-text-muted/55'
                        }`}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Forward className="h-4 w-4" />
                        Forward Message
                      </button>
                    )}
                    {contextMenu.msg.sender_id === currentUserId && !isFailedLocalMessage && (
                      <>
                        <div className="mx-4 h-px bg-void-bg-hover/60" />
                        {onEdit && (
                          <button
                            onClick={() => {
                              onEdit(contextMenu.msg);
                              onCloseContextMenu();
                            }}
                            className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover/90"
                            style={{ WebkitTapHighlightColor: 'transparent' }}
                          >
                            <Pencil className="h-4 w-4" />
                            Edit Message
                          </button>
                        )}
                        <button
                          onClick={() => {
                            onDelete(contextMenu.msg.message_id);
                            onCloseContextMenu();
                          }}
                          className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-red-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
                          style={{ WebkitTapHighlightColor: 'transparent' }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete Message
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : desktopReactionsOnly ? (
          <div
            className={`fixed z-[70] flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur select-none transition-all duration-150 ease-out ${
              contextMenuVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.98] opacity-0'
            }`}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {QUICK_REACTIONS.map(({ emoji, label }) => {
              const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
              const isDisabled = isFailedLocalMessage || !messageCanAddReaction(contextMenu.msg, emoji);

              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => handleQuickReaction(emoji)}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all ${
                    isDisabled
                      ? 'cursor-not-allowed opacity-40'
                      : isSelected
                      ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                      : 'hover:bg-void-bg-hover/80'
                  }`}
                  aria-label={label}
                  title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <EmojiGlyph
                    emoji={emoji}
                    className="text-[18px]"
                    fallbackClassName="text-[18px]"
                  />
                </button>
              );
            })}

            {canOpenReactionPicker && (
              <button
                type="button"
                onClick={() => {
                  onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                    x: contextMenu.x,
                    y: contextMenu.y,
                  });
                  onCloseContextMenu();
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80"
                aria-label="Add reaction"
                title="Add reaction"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
          </div>
        ) : (
          <div
            className={`fixed z-[70] flex max-w-[calc(100vw-1rem)] flex-col items-center gap-2 select-none transition-all duration-150 ease-out ${
              contextMenuVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.98] opacity-0'
            }`}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {!isFailedLocalMessage && (
            <div className="w-max max-w-[calc(100vw-1rem)] rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur">
              <div className="rounded-2xl bg-void-bg-hover/35 px-1.5 py-1.5">
                <div className="flex w-max min-w-0 items-center gap-1">
                  {QUICK_REACTIONS.map(({ emoji, label }) => {
                    const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
                    const isDisabled = isFailedLocalMessage || !messageCanAddReaction(contextMenu.msg, emoji);

                    return (
                      <button
                        key={emoji}
                        type="button"
                        disabled={isDisabled}
                        onClick={() => handleQuickReaction(emoji)}
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all ${
                          isDisabled
                            ? 'cursor-not-allowed opacity-40'
                            : isSelected
                              ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                              : 'hover:bg-void-bg-hover/80'
                        }`}
                        aria-label={label}
                        title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <EmojiGlyph
                          emoji={emoji}
                          className="text-[18px]"
                          fallbackClassName="text-[18px]"
                        />
                      </button>
                    );
                  })}

                  {canOpenReactionPicker && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                          x: contextMenu.x,
                          y: contextMenu.y,
                        });
                        onCloseContextMenu();
                      }}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80"
                      aria-label="Add reaction"
                      title="Add reaction"
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Plus className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            )}

            <div className="w-[15.5rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur">
              {isFailedLocalMessage && onRetryFailed && (
                <button
                  onClick={() => {
                    onRetryFailed(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-orange-300 transition-colors hover:bg-orange-500/15 hover:text-orange-200"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <RefreshCcw className="w-4 h-4" />
                  Retry Send
                </button>
              )}
              {!isFailedLocalMessage && (
                <button
                  disabled={!canOpenReactionPicker}
                  onClick={() => {
                    if (!canOpenReactionPicker) return;
                    onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                      x: contextMenu.x,
                      y: contextMenu.y,
                    });
                    onCloseContextMenu();
                  }}
                  className={`flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    canOpenReactionPicker
                      ? 'text-void-text hover:bg-void-accent hover:text-white'
                      : 'cursor-not-allowed text-void-text-muted/60'
                  }`}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Smile className="w-4 h-4" />
                  Add Reaction
                </button>
              )}
              <button
                onClick={async () => {
                  await onCopyMessageText(contextMenu.msg.content);
                  onCloseContextMenu();
                }}
                disabled={!contextMenuIsCopyable}
                className={`flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  contextMenuIsCopyable
                    ? 'text-void-text hover:bg-void-accent hover:text-white'
                    : 'cursor-not-allowed text-void-text-muted/60'
                }`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Copy className="w-4 h-4" />
                Copy Text
              </button>
              {onReply && !isFailedLocalMessage && (
                <button
                  onClick={() => {
                    onReply(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Reply className="w-4 h-4" />
                  Reply
                </button>
              )}
              {!isFailedLocalMessage && (
                <button
                  disabled={!canForwardMessage}
                  onClick={() => {
                    if (!canForwardMessage || !contextMenu || !onForward) return;
                    onForward(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    canForwardMessage
                      ? 'text-void-text hover:bg-void-accent hover:text-white'
                      : 'cursor-not-allowed text-void-text-muted/60'
                  }`}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Forward className="w-4 h-4" />
                  Forward Message
                </button>
              )}
              {contextMenu.msg.sender_id === currentUserId && !isFailedLocalMessage && (
                <>
                  <div className="my-1 h-px w-full bg-void-bg-hover" />
                  {onEdit && (
                    <button
                      onClick={() => {
                        onEdit(contextMenu.msg);
                        onCloseContextMenu();
                      }}
                      className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Pencil className="w-4 h-4" />
                      Edit Message
                    </button>
                  )}
                  <button
                    onClick={() => {
                      onDelete(contextMenu.msg.message_id);
                      onCloseContextMenu();
                    }}
                    className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500 hover:text-white"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Message
                  </button>
                </>
              )}
            </div>
          </div>
        ),
        document.body,
      )}

      {selectedProfileId && (
        <Suspense fallback={null}>
          <UserProfileModal profileId={selectedProfileId} onClose={onCloseProfile} />
        </Suspense>
      )}

      {selectedFriend && (
        <FriendProfile friend={selectedFriend} onClose={onCloseFriend} />
      )}

      {imageViewer && createPortal(
        <ImageViewerOverlay
          key={imageViewer.sessionId}
          imageViewer={imageViewer}
          onClose={onCloseImageViewer}
          onPrevious={onPreviousImage}
          onNext={onNextImage}
          onSelectIndex={onSelectImageIndex}
        />,
        document.body,
      )}
    </>
  );
}
