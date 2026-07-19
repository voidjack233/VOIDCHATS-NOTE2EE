import { useMemo } from 'react';
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileText,
  FileVideo,
} from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { getCachedAttachmentObjectUrl } from '../../../Services/Chat/attachmentService';

interface AttachmentFileCardProps {
  attachment: Attachment;
  disabled?: boolean;
}

function formatAttachmentSize(size?: number): string {
  if (!Number.isFinite(size) || !size || size <= 0) {
    return 'File';
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function getAttachmentDisplayName(attachment: Attachment): string {
  if (attachment.name && attachment.name.trim().length > 0) {
    return attachment.name.trim();
  }

  try {
    const pathname = new URL(attachment.url).pathname;
    const lastSegment = pathname.split('/').pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // ignore invalid URL parsing
  }

  return 'attachment';
}

function getAttachmentIcon(mime: string | undefined) {
  if (!mime) return File;
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime.startsWith('video/')) return FileVideo;
  if (
    mime.includes('zip') ||
    mime.includes('tar') ||
    mime.includes('rar') ||
    mime.includes('7z') ||
    mime.includes('archive')
  ) {
    return FileArchive;
  }
  if (
    mime.includes('pdf') ||
    mime.includes('text') ||
    mime.includes('word') ||
    mime.includes('sheet') ||
    mime.includes('presentation') ||
    mime.includes('document')
  ) {
    return FileText;
  }
  return File;
}

export default function AttachmentFileCard({
  attachment,
  disabled = false,
}: AttachmentFileCardProps) {
  const displayName = useMemo(() => getAttachmentDisplayName(attachment), [attachment]);
  const Icon = getAttachmentIcon(attachment.mime);
  const downloadUrl = getCachedAttachmentObjectUrl(attachment) ||
    attachment.fallback_url?.trim() ||
    (attachment.url_expires_at === undefined ? attachment.url.trim() : null);

  const handleDownload = () => {
    if (disabled || !downloadUrl) return;

    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = displayName;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={disabled || !downloadUrl}
      className="flex w-full items-center gap-3 rounded-xl border border-void-bg-hover bg-void-bg-hover/75 px-3 py-3 text-left transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-void-bg-main/80">
        <Icon className="h-5 w-5 text-void-accent" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-void-text">
          {displayName}
        </div>
        <div className="truncate text-xs text-void-text-muted">
          {formatAttachmentSize(attachment.size)}
        </div>
      </div>

      <Download className="h-4 w-4 shrink-0 text-void-text-muted" />
    </button>
  );
}
