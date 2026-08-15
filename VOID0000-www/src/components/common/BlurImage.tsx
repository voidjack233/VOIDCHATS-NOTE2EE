// src/components/common/BlurImage.tsx
// Image with blurhash canvas placeholder that fades out once the image loads.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { decode } from 'blurhash';

interface BlurImageProps {
  src: string;
  srcSet?: string;
  sizes?: string;
  blurhash?: string;
  alt?: string;
  className?: string;
  onLoad?: (image: HTMLImageElement) => void;
  onError?: (image: HTMLImageElement) => void;
  loading?: 'eager' | 'lazy';
}

const THUMB = 32; // decode resolution — small for perf, upscaled via CSS

interface BlurhashPlaceholderProps {
  blurhash?: string;
  className?: string;
}

export const BlurhashPlaceholder = ({
  blurhash,
  className = '',
}: BlurhashPlaceholderProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!blurhash || !canvasRef.current) return;
    try {
      const pixels = decode(blurhash, THUMB, THUMB);
      const ctx = canvasRef.current.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.createImageData(THUMB, THUMB);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // invalid hash — canvas stays blank
    }
  }, [blurhash]);

  if (!blurhash) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      width={THUMB}
      height={THUMB}
      className={className}
    />
  );
};

const BlurImage = ({
  src,
  srcSet,
  sizes,
  blurhash,
  alt = '',
  className = '',
  onLoad,
  onError,
  loading = 'lazy',
}: BlurImageProps) => {
  const imageRef = useRef<HTMLImageElement>(null);
  const reportedLoadedSrcRef = useRef<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const sourceIdentity = `${src}\n${srcSet || ''}`;
  const loaded = loadedSrc === sourceIdentity;

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image?.complete || image.naturalWidth <= 0) return;

    setLoadedSrc(sourceIdentity);
    if (reportedLoadedSrcRef.current !== sourceIdentity) {
      reportedLoadedSrcRef.current = sourceIdentity;
      onLoad?.(image);
    }
  }, [onLoad, sourceIdentity]);

  return (
    <div className="relative w-full h-full">
      {blurhash && !loaded && (
        <BlurhashPlaceholder
          blurhash={blurhash}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <img
        ref={imageRef}
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        loading={loading}
        decoding="async"
        style={{ visibility: loaded ? 'visible' : 'hidden' }}
        onLoad={(event) => {
          setLoadedSrc(sourceIdentity);
          if (reportedLoadedSrcRef.current !== sourceIdentity) {
            reportedLoadedSrcRef.current = sourceIdentity;
            onLoad?.(event.currentTarget);
          }
        }}
        onError={(event) => {
          setLoadedSrc((current) => (current === sourceIdentity ? null : current));
          onError?.(event.currentTarget);
        }}
        className={`${className} transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
};

export default BlurImage;
