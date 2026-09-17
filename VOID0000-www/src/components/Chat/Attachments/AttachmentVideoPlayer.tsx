import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { API_URL } from '../../../Services/config';
import { isAttachmentDeliveryUrlUsable } from '../../../Services/Chat/attachmentService';
import { getSingleAttachmentReservedPresentation } from './messageAttachmentLayout';
import { useMediaViewport } from './useMediaViewport';

function isVideoAttachment(attachment: Attachment): boolean {
  return attachment.mime === 'video/mp4' && attachment.video_trusted === true && attachment.inline === true;
}

export default function AttachmentVideoPlayer({ attachment, disabled = false, canLoad = true }: { attachment: Attachment; disabled?: boolean; canLoad?: boolean }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [failedPosters, setFailedPosters] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [requestedPlay, setRequestedPlay] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const presentation = getSingleAttachmentReservedPresentation(attachment);
  const fallback = attachment.fallback_url?.trim();
  const fallbackUrl = fallback?.startsWith('/api/') ? `${API_URL}${fallback}` : fallback;
  const urls = [
    isAttachmentDeliveryUrlUsable(attachment.url, attachment.url_expires_at) ? attachment.url : null,
    fallbackUrl,
  ].filter((url): url is string => Boolean(url));
  const src = urls.find(url => !failedUrls.includes(url));
  const hidden = attachment.spoiler === true && !revealed;
  const { ref: frameRef, canLoad: mediaCanLoad, loading, fetchPriority } = useMediaViewport(canLoad && !disabled && !hidden);
  const poster = attachment.poster && isAttachmentDeliveryUrlUsable(attachment.poster.url, attachment.poster.url_expires_at)
    ? attachment.poster.url : undefined;
  useEffect(() => {
    // Only an explicit play click mounts the player. Native controls remain
    // available if the browser denies playback or the user later pauses.
    if (requestedPlay) void videoRef.current?.play().catch(() => {});
  }, [requestedPlay, src]);
  return (
    <div ref={frameRef} className="relative max-w-full overflow-hidden rounded-xl bg-black" style={{ width: presentation.width, aspectRatio: presentation.aspectRatio }}>
      {hidden ? (
        <button type="button" className="absolute inset-0 text-sm text-white" onClick={() => setRevealed(true)}>Reveal video spoiler</button>
      ) : !disabled && src && isVideoAttachment(attachment) && requestedPlay ? (
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" src={src} poster={poster}
          width={attachment.width} height={attachment.height} controls playsInline preload="none"
          aria-label={attachment.name || 'Video attachment'}
          onError={() => setFailedUrls(previous => previous.includes(src) ? previous : [...previous.slice(-7), src])} />
      ) : !disabled && src && isVideoAttachment(attachment) ? (
        <button type="button" className="absolute inset-0 flex h-full w-full items-center justify-center text-white focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-void-accent"
          aria-label={`Play video: ${attachment.name || 'attachment'}`} onClick={() => setRequestedPlay(true)}>
          {mediaCanLoad && poster && !failedPosters.includes(poster) ? (
            <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain" decoding="async"
              loading={loading} fetchPriority={fetchPriority}
              onError={() => setFailedPosters(previous => previous.includes(poster) ? previous : [...previous.slice(-7), poster])} />
          ) : null}
          <span className="relative flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-black/65">
            <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden="true" />
          </span>
          {Number.isFinite(attachment.duration_ms) && Number(attachment.duration_ms) > 0 ? (
            <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-xs tabular-nums">
              {Math.floor(Number(attachment.duration_ms) / 60000)}:{String(Math.floor(Number(attachment.duration_ms) / 1000) % 60).padStart(2, '0')}
            </span>
          ) : null}
        </button>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white" role="status">
          {disabled ? 'Video ready to send' : 'Video unavailable'}
        </div>
      )}
    </div>
  );
}
