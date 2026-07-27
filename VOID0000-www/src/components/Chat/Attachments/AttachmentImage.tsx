import { useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import {
  getAttachmentRenderIdentity,
  getAttachmentRenderSources,
} from '../../../Services/Chat/attachmentService';
import BlurImage, { BlurhashPlaceholder } from '../../common/BlurImage';
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
}

export default function AttachmentImage({
  attachment,
  alt = '',
  className = '',
  onLoad,
  canLoad = true,
}: AttachmentImageProps) {
  const attachmentIdentity = getAttachmentRenderIdentity(attachment);
  const availableSources = canLoad ? getAttachmentRenderSources(attachment) : [];
  const [attemptState, setAttemptState] = useState(() => (
    createAttachmentImageAttemptState(attachmentIdentity)
  ));
  const source = selectAttachmentImageSource(
    attemptState,
    attachmentIdentity,
    availableSources,
  );
  const failed = canLoad && !source;

  if (source) {
    return (
      <BlurImage
        key={source.url}
        src={source.url}
        blurhash={attachment.blurhash}
        alt={alt}
        className={className}
        onLoad={() => {
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
        }}
        loading="eager"
      />
    );
  }

  return (
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
  );
}
