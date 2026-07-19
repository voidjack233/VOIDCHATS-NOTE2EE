import { useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import {
  getCachedAttachmentObjectUrl,
} from '../../../Services/Chat/attachmentService';
import BlurImage, { BlurhashPlaceholder } from '../../common/BlurImage';

interface AttachmentImageProps {
  attachment: Attachment;
  alt?: string;
  className?: string;
  onLoad?: () => void;
  canLoad?: boolean;
}

export default function AttachmentImage({
  attachment,
  alt = '',
  className = '',
  onLoad,
  canLoad = true,
}: AttachmentImageProps) {
  const availableSrc = canLoad ? getCachedAttachmentObjectUrl(attachment) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = canLoad && (!availableSrc || failedSrc === availableSrc);
  const src = failed ? null : availableSrc;

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
          setFailedSrc(src);
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
