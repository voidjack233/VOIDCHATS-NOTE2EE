import { useRef, useState, type SyntheticEvent } from 'react';
import { getAvatarInitial, isGeneratedFallbackAvatarUrl } from '../../Services/Chat/avatarFallback';

const MAX_REMEMBERED_AVATAR_URLS = 512;
const loadedAvatarUrls = new Set<string>();

function rememberLoadedAvatar(url: string) {
  loadedAvatarUrls.delete(url);
  loadedAvatarUrls.add(url);

  if (loadedAvatarUrls.size > MAX_REMEMBERED_AVATAR_URLS) {
    const oldestUrl = loadedAvatarUrls.values().next().value;
    if (oldestUrl) loadedAvatarUrls.delete(oldestUrl);
  }
}

function afterDecode(image: HTMLImageElement, callback: () => void) {
  if (typeof image.decode !== 'function') {
    callback();
    return;
  }

  void image.decode().then(callback, callback);
}

interface UserAvatarProps {
  src?: string | null;
  displayName?: string | null;
  username?: string | null;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  imgClassName?: string;
  fallbackTone?: 'badge' | 'plain';
}

type AvatarImageState = {
  src: string;
  status: 'loaded' | 'failed';
};

export default function UserAvatar({
  src,
  displayName,
  username,
  alt = '',
  className = '',
  fallbackClassName = '',
  imgClassName = '',
  fallbackTone = 'badge',
}: UserAvatarProps) {
  const normalizedSrc = isGeneratedFallbackAvatarUrl(src) ? null : src;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageState, setImageState] = useState<AvatarImageState | null>(() =>
    normalizedSrc && loadedAvatarUrls.has(normalizedSrc)
      ? { src: normalizedSrc, status: 'loaded' }
      : null
  );

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!normalizedSrc) return;
    const image = event.currentTarget;

    afterDecode(image, () => {
      if (imageRef.current !== image || image.getAttribute('src') !== normalizedSrc) return;
      rememberLoadedAvatar(normalizedSrc);
      setImageState({ src: normalizedSrc, status: 'loaded' });
    });
  };

  const handleError = () => {
    if (!normalizedSrc) return;
    loadedAvatarUrls.delete(normalizedSrc);
    setImageState({ src: normalizedSrc, status: 'failed' });
  };

  const fallbackToneClass = fallbackTone === 'plain'
    ? 'bg-transparent text-void-text'
    : 'bg-void-accent/15 text-void-accent';

  const imageLoaded = Boolean(normalizedSrc && (
    (imageState?.src === normalizedSrc && imageState.status === 'loaded') ||
    (imageState?.src !== normalizedSrc && loadedAvatarUrls.has(normalizedSrc))
  ));
  const imageFailed = Boolean(
    normalizedSrc && imageState?.src === normalizedSrc && imageState.status === 'failed'
  );

  return (
    <span
      className={`${className} relative inline-flex overflow-hidden`.trim()}
      data-avatar-state={imageFailed ? 'failed' : imageLoaded ? 'loaded' : 'loading'}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 flex items-center justify-center ${fallbackToneClass} font-semibold select-none transition-opacity duration-150 ease-out motion-reduce:transition-none ${imageLoaded ? 'opacity-0' : 'opacity-100'} ${fallbackClassName}`.trim()}
      >
        {getAvatarInitial(displayName, username)}
      </span>

      {normalizedSrc ? (
        <img
          ref={imageRef}
          src={normalizedSrc}
          alt={alt}
          decoding="async"
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 h-full w-full rounded-[inherit] object-cover transition-opacity duration-150 ease-out motion-reduce:transition-none ${imageLoaded ? 'opacity-100' : 'opacity-0'} ${imgClassName}`.trim()}
        />
      ) : null}
    </span>
  );
}
