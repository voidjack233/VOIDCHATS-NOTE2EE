import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import {
  getAttachmentRenderIdentity,
  getAttachmentRenderSources,
} from '../../../Services/Chat/attachmentService';
import BlurImage, { BlurhashPlaceholder } from '../../common/BlurImage';
import { useMediaViewport } from './useMediaViewport';
import {
  createAttachmentImageAttemptState,
  recordAttachmentImageFailure,
  recordAttachmentImageSuccess,
  selectAttachmentImageSource,
} from './attachmentImageRetry';

interface AttachmentImageProps {
  attachment: Attachment;
  alt?: string;
  className?: string;
  onLoad?: () => void;
  canLoad?: boolean;
  onRefreshDelivery?: () => Promise<unknown>;
}

export default function AttachmentImage({
  attachment,
  alt = '',
  className = '',
  onLoad,
  canLoad = true,
  onRefreshDelivery,
}: AttachmentImageProps) {
  const { ref: frameRef, canLoad: mediaCanLoad, loading, fetchPriority } = useMediaViewport(canLoad);
  const attachmentIdentity = getAttachmentRenderIdentity(attachment);
  const availableSources = mediaCanLoad ? getAttachmentRenderSources(attachment) : [];
  const [attemptState, setAttemptState] = useState(() => (
    createAttachmentImageAttemptState(attachmentIdentity)
  ));
  const [displayedSource, setDisplayedSource] = useState<{
    attachmentIdentity: string;
    source: NonNullable<ReturnType<typeof selectAttachmentImageSource>>;
  } | null>(null);
  const refreshAttemptedGenerationRef = useRef<string | null>(null);
  const source = selectAttachmentImageSource(
    attemptState,
    attachmentIdentity,
    availableSources,
  );
  const displayed = displayedSource?.attachmentIdentity === attachmentIdentity
    ? displayedSource.source
    : null;
  const isLoadingReplacement = Boolean(source && displayed && source.url !== displayed.url);
  // Expired metadata is a refresh state, not a failed image. Only show ImageOff
  // after an actual usable source has exhausted its bounded attempts.
  const failed = mediaCanLoad && !source && !displayed && attemptState.failures.length > 0;
  const deliveryGeneration = availableSources.map((candidate) => candidate.url).join('|') || [
    attachment.display_url,
    attachment.display_url_expires_at,
    attachment.url,
    attachment.url_expires_at,
  ].join('|');

  const refreshDeliveryOnce = useCallback((failedSourceUrl?: string) => {
    const generation = failedSourceUrl || deliveryGeneration;
    if (!onRefreshDelivery || refreshAttemptedGenerationRef.current === generation) return;
    refreshAttemptedGenerationRef.current = generation;
    void onRefreshDelivery();
  }, [deliveryGeneration, onRefreshDelivery]);

  useEffect(() => {
    if (mediaCanLoad && availableSources.length === 0) refreshDeliveryOnce();
  }, [availableSources.length, mediaCanLoad, refreshDeliveryOnce]);

  return (
    <div ref={frameRef} className="absolute inset-0">
    {displayed ? (
      <BlurImage
        key={displayed.url}
        src={displayed.url}
        srcSet={displayed.srcSet}
        sizes={displayed.sizes}
        blurhash={attachment.blurhash}
        alt={alt}
        className={className}
        retainLoadedOnError
        onError={() => {
          // A tab-return revalidation can fail after this image was decoded.
          // Keep its display layer intact and use the generation-bounded refresh.
          refreshDeliveryOnce(displayed.url);
        }}
        loading={loading}
        fetchPriority={fetchPriority}
      />
    ) : source ? (
      <BlurImage
        key={source.url}
        src={source.url}
        srcSet={source.srcSet}
        sizes={source.sizes}
        blurhash={attachment.blurhash}
        alt={alt}
        className={className}
        onLoad={() => {
          setDisplayedSource({ attachmentIdentity, source });
          setAttemptState((current) => recordAttachmentImageSuccess(
            current,
            attachmentIdentity,
            source,
          ));
          onLoad?.();
        }}
        onError={() => {
          setAttemptState((current) => recordAttachmentImageFailure(
            current,
            attachmentIdentity,
            source,
          ));
          refreshDeliveryOnce(source.url);
        }}
        loading={loading}
        fetchPriority={fetchPriority}
      />
    ) : (
    <div className={`relative overflow-hidden bg-void-bg-main/50 ${className}`}>
      {!failed && attachment.blurhash ? (
        <BlurhashPlaceholder
          blurhash={attachment.blurhash}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}

      <div className="absolute inset-0 flex items-center justify-center bg-void-bg-main/25">
        {failed ? (
          <ImageOff className="h-5 w-5 text-void-text-muted" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-void-text-muted" />
        )}
      </div>
    </div>
    )}
    {isLoadingReplacement && source ? (
      <BlurImage
        key={`replacement:${source.url}`}
        src={source.url}
        srcSet={source.srcSet}
        sizes={source.sizes}
        blurhash={attachment.blurhash}
        alt=""
        className="absolute inset-0 opacity-0 pointer-events-none"
        onLoad={() => {
          setDisplayedSource({ attachmentIdentity, source });
          setAttemptState((current) => recordAttachmentImageSuccess(current, attachmentIdentity, source));
          onLoad?.();
        }}
        onError={() => {
          setAttemptState((current) => recordAttachmentImageFailure(current, attachmentIdentity, source));
          refreshDeliveryOnce(source.url);
        }}
        loading={loading}
        fetchPriority={fetchPriority}
      />
    ) : null}
    </div>
  );
}
