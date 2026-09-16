import { useState } from 'react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { API_URL } from '../../../Services/config';
import { isAttachmentDeliveryUrlUsable } from '../../../Services/Chat/attachmentService';
import { getSingleAttachmentReservedPresentation } from './messageAttachmentLayout';

function isVideoAttachment(attachment: Attachment): boolean {
  return attachment.mime === 'video/mp4' && attachment.video_trusted === true && attachment.inline === true;
}

export default function AttachmentVideoPlayer({ attachment, disabled = false }: { attachment: Attachment; disabled?: boolean }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const presentation = getSingleAttachmentReservedPresentation(attachment);
  const fallback = attachment.fallback_url?.trim();
  const fallbackUrl = fallback?.startsWith('/api/') ? `${API_URL}${fallback}` : fallback;
  const urls = [
    isAttachmentDeliveryUrlUsable(attachment.url, attachment.url_expires_at) ? attachment.url : null,
    fallbackUrl,
  ].filter((url): url is string => Boolean(url));
  const src = urls.find(url => !failedUrls.includes(url));
  const hidden = attachment.spoiler === true && !revealed;
  const poster = attachment.poster && isAttachmentDeliveryUrlUsable(attachment.poster.url, attachment.poster.url_expires_at)
    ? attachment.poster.url : undefined;
  return (
    <div className="relative max-w-full overflow-hidden rounded-xl bg-black" style={{ width: presentation.width, aspectRatio: presentation.aspectRatio }}>
      {hidden ? (
        <button type="button" className="absolute inset-0 text-sm text-white" onClick={() => setRevealed(true)}>Reveal video spoiler</button>
      ) : !disabled && src && isVideoAttachment(attachment) ? (
        <video className="absolute inset-0 h-full w-full object-contain" src={src} poster={poster}
          width={attachment.width} height={attachment.height} controls playsInline preload="none"
          aria-label={attachment.name || 'Video attachment'}
          onError={() => setFailedUrls(previous => previous.includes(src) ? previous : [...previous.slice(-7), src])} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white" role="status">
          {disabled ? 'Video ready to send' : 'Video unavailable'}
        </div>
      )}
    </div>
  );
}
