import { useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import {
  getCachedAttachmentObjectUrl,
  refreshAttachmentDeliveryCapability,
  resolveAttachmentObjectUrl,
} from '../../../Services/Chat/attachmentService';
import BlurImage, { BlurhashPlaceholder } from '../../common/BlurImage';

interface AttachmentImageProps {
  attachment: Attachment;
  conversationId?: string | null;
  alt?: string;
  className?: string;
  onLoad?: () => void;
  canLoad?: boolean;
}

export default function AttachmentImage({
  attachment,
  conversationId,
  alt = '',
  className = '',
  onLoad,
  canLoad = true,
}: AttachmentImageProps) {
  const [src, setSrc] = useState<string | null>(
    canLoad ? getCachedAttachmentObjectUrl(attachment) : null,
  );
  const [failed, setFailed] = useState(false);
  const refreshAttemptedRef = useRef(false);
  const requestRevisionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const requestRevision = ++requestRevisionRef.current;
    setFailed(false);
    refreshAttemptedRef.current = false;

    if (!canLoad) {
      setSrc(null);
      return () => {
        cancelled = true;
        if (requestRevisionRef.current === requestRevision) requestRevisionRef.current += 1;
      };
    }

    const cachedUrl = getCachedAttachmentObjectUrl(attachment);
    if (cachedUrl) {
      setSrc(cachedUrl);
      return () => {
        cancelled = true;
        if (requestRevisionRef.current === requestRevision) requestRevisionRef.current += 1;
      };
    }

    setSrc(null);
    refreshAttemptedRef.current = true;

    resolveAttachmentObjectUrl(attachment, { conversationId })
      .then((nextUrl) => {
        if (!cancelled) {
          setSrc(nextUrl);
        }
      })
      .catch((error) => {
        console.error('Failed to load attachment image:', error);
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
      if (requestRevisionRef.current === requestRevision) requestRevisionRef.current += 1;
    };
  }, [attachment, conversationId, canLoad]);

  if (src) {
    return (
      <BlurImage
        src={src}
        blurhash={attachment.blurhash}
        alt={alt}
        className={className}
        onLoad={() => {
          onLoad?.();
        }}
        onError={() => {
          if (refreshAttemptedRef.current) {
            setFailed(true);
            setSrc(null);
            return;
          }

          refreshAttemptedRef.current = true;
          const requestRevision = ++requestRevisionRef.current;
          setFailed(false);
          setSrc(null);
          void refreshAttachmentDeliveryCapability(attachment, { conversationId })
            .then((delivery) => {
              if (requestRevisionRef.current === requestRevision) {
                setFailed(false);
                setSrc(delivery.url);
              }
            })
            .catch((error) => {
              console.error('Failed to refresh attachment image delivery:', error);
              if (requestRevisionRef.current === requestRevision) {
                setFailed(true);
              }
            });
        }}
        loading="eager"
      />
    );
  }

  return (
    <div className={`relative overflow-hidden bg-void-bg-main/50 ${className}`}>
      {attachment.blurhash ? (
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
  );
}
