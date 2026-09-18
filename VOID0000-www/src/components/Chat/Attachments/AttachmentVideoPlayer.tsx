import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { Expand, LoaderCircle, Maximize, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { API_URL } from '../../../Services/config';
import { isAttachmentDeliveryUrlUsable } from '../../../Services/Chat/attachmentService';
import { getSingleAttachmentReservedPresentation } from './messageAttachmentLayout';
import { useMediaViewport } from './useMediaViewport';

function isVideoAttachment(attachment: Attachment): boolean {
  return attachment.mime === 'video/mp4' && attachment.video_trusted === true && attachment.inline === true;
}

const CONTROLS_HIDE_DELAY = 2400;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const suffix = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${suffix}` : `${minutes}:${suffix}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

export default function AttachmentVideoPlayer({ attachment, disabled = false, canLoad = true }: { attachment: Attachment; disabled?: boolean; canLoad?: boolean }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [failedPosters, setFailedPosters] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [requestedPlay, setRequestedPlay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [controlActivity, setControlActivity] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const waitingTimer = useRef<number | null>(null);
  const presentation = getSingleAttachmentReservedPresentation(attachment);
  const fallback = attachment.fallback_url?.trim();
  const fallbackUrl = fallback?.startsWith('/api/') ? `${API_URL}${fallback}` : fallback;
  const urls = [isAttachmentDeliveryUrlUsable(attachment.url, attachment.url_expires_at) ? attachment.url : null, fallbackUrl].filter((url): url is string => Boolean(url));
  const src = urls.find((url) => !failedUrls.includes(url));
  const hidden = attachment.spoiler === true && !revealed;
  const viewport = useMediaViewport(canLoad && !disabled && !hidden);
  const poster = attachment.poster && isAttachmentDeliveryUrlUsable(attachment.poster.url, attachment.poster.url_expires_at) ? attachment.poster.url : undefined;
  const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0;
  const buffered = duration > 0 ? Math.min(100, bufferedEnd / duration * 100) : 0;

  const showControls = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setControlsVisible(true);
    hideTimer.current = null;
    if (playing) setControlActivity((activity) => activity + 1);
  }, [playing]);
  const hideControlsLater = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY);
  }, [playing]);
  const clearWaiting = useCallback(() => {
    if (waitingTimer.current !== null) window.clearTimeout(waitingTimer.current);
    waitingTimer.current = null;
    setWaiting(false);
  }, []);
  const togglePlayback = useCallback(() => {
    if (!src) return;
    showControls(); setPlaybackFailed(false);
    if (!requestedPlay) { setRequestedPlay(true); return; }
    if (videoRef.current?.paused) void videoRef.current.play().catch(() => setPlaybackFailed(true));
    else videoRef.current?.pause();
  }, [requestedPlay, showControls, src]);
  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(time)) return;
    const next = Math.max(0, Math.min(duration || video.duration || 0, time));
    video.currentTime = next; setCurrentTime(next);
  }, [duration]);
  const toggleMute = useCallback(() => {
    const video = videoRef.current; if (!video) return;
    video.muted = !video.muted; setMuted(video.muted); showControls();
  }, [showControls]);
  const changeVolume = useCallback((next: number) => {
    const video = videoRef.current; if (!video) return;
    const value = Math.max(0, Math.min(1, next));
    video.volume = value; video.muted = value === 0; setVolume(value); setMuted(video.muted); showControls();
  }, [showControls]);
  const toggleFullscreen = useCallback(async () => {
    if (!frameRef.current) return;
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await frameRef.current.requestFullscreen(); }
    catch { showControls(); }
  }, [showControls]);

  useEffect(() => { if (requestedPlay && src) void videoRef.current?.play().catch(() => setPlaybackFailed(true)); }, [requestedPlay, src]);
  useEffect(() => { if (playing) hideControlsLater(); }, [controlActivity, hideControlsLater, playing]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => () => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); if (waitingTimer.current !== null) window.clearTimeout(waitingTimer.current); }, []);
  const handleError = () => {
    clearWaiting();
    if (src) setFailedUrls((previous) => previous.includes(src) ? previous : [...previous.slice(-7), src]);
    if (!urls.some((url) => url !== src && !failedUrls.includes(url))) setPlaybackFailed(true);
  };
  const retry = () => { setFailedUrls([]); setPlaybackFailed(false); setRequestedPlay(false); window.setTimeout(() => setRequestedPlay(true), 0); };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (event.key === ' ' || key === 'k') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seekTo(currentTime - 5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seekTo(currentTime + 5); }
    else if (key === 'm') { event.preventDefault(); toggleMute(); }
    else if (key === 'f') { event.preventDefault(); void toggleFullscreen(); }
    showControls();
  };

  return (
    <div ref={(node) => { frameRef.current = node; viewport.ref(node); }} className="void-video-player relative max-w-full overflow-hidden rounded-xl bg-black" style={{ width: presentation.width, aspectRatio: presentation.aspectRatio }} onPointerMove={showControls} onPointerDown={showControls} onFocusCapture={showControls} onMouseLeave={hideControlsLater} onKeyDown={handleKeyDown} tabIndex={requestedPlay ? 0 : -1}>
      {hidden ? <button type="button" className="absolute inset-0 text-sm text-white" onClick={() => setRevealed(true)}>Reveal video spoiler</button> : !disabled && src && isVideoAttachment(attachment) && requestedPlay ? <>
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" src={src} poster={poster} width={attachment.width} height={attachment.height} playsInline preload="none" aria-label={attachment.name || 'Video attachment'}
          onPlay={() => { setPlaying(true); setPlaybackFailed(false); hideControlsLater(); }} onPause={() => { setPlaying(false); showControls(); }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onProgress={(event) => { const ranges = event.currentTarget.buffered; if (ranges.length) setBufferedEnd(ranges.end(ranges.length - 1)); }} onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }} onWaiting={() => { if (waitingTimer.current !== null) window.clearTimeout(waitingTimer.current); waitingTimer.current = window.setTimeout(() => setWaiting(true), 180); }} onCanPlay={clearWaiting} onPlaying={clearWaiting} onError={handleError} />
        {waiting ? <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20" role="status" aria-label="Video buffering"><LoaderCircle className="h-7 w-7 animate-spin text-white drop-shadow" /></div> : null}
        {playbackFailed ? <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/65 px-5 text-center text-sm text-white"><span>Video playback is unavailable.</span><button type="button" onClick={retry} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-void-bg-sec/90 px-3 py-2 text-xs font-semibold hover:bg-void-bg-hover"><RotateCcw className="h-3.5 w-3.5" />Retry</button></div> : <div data-video-controls className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-3 pt-10 transition-opacity duration-200 ${controlsVisible || !playing ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
          <div className="flex items-center gap-2 text-white"><button type="button" onClick={togglePlayback} className="shrink-0 rounded-lg p-2 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-void-accent" aria-label={playing ? 'Pause video' : 'Play video'}>{playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}</button>{fullscreen ? <span className="shrink-0 text-xs tabular-nums text-white/85">{formatTime(currentTime)} / {formatTime(duration)}</span> : null}<input className="void-video-progress block h-5 min-w-0 flex-1 cursor-pointer touch-manipulation appearance-none bg-transparent" type="range" min="0" max={duration || 0} step="0.01" value={Math.min(currentTime, duration || 0)} aria-label="Video playback position" aria-valuemin={0} aria-valuemax={duration || 0} aria-valuenow={currentTime} aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`} style={{ '--video-played': `${progress}%`, '--video-buffered': `${Math.max(progress, buffered)}%` } as CSSProperties} onPointerDown={showControls} onChange={(event) => seekTo(Number(event.target.value))} /><div className="relative flex shrink-0 items-center" onPointerEnter={() => setVolumeExpanded(true)} onPointerLeave={() => setVolumeExpanded(false)} onFocus={() => setVolumeExpanded(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setVolumeExpanded(false); }}><button type="button" onClick={toggleMute} className="rounded-lg p-2 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-void-accent" aria-label={muted || volume === 0 ? 'Unmute video' : 'Mute video'}>{muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button><div className={`hidden overflow-hidden transition-[max-width,opacity] duration-150 sm:block ${volumeExpanded ? 'max-w-24 opacity-100' : 'max-w-0 opacity-0'}`}><input className="ml-1 w-20 accent-void-accent" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => changeVolume(Number(event.target.value))} aria-label="Video volume" tabIndex={volumeExpanded ? 0 : -1} /></div></div><button type="button" onClick={() => void toggleFullscreen()} className="shrink-0 rounded-lg p-2 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-void-accent" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>{fullscreen ? <Expand className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</button></div>
        </div>}
      </> : !disabled && src && isVideoAttachment(attachment) ? <button type="button" className="absolute inset-0 flex h-full w-full items-center justify-center text-white focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-void-accent" aria-label={`Play video: ${attachment.name || 'attachment'}`} onClick={togglePlayback}>{viewport.canLoad && poster && !failedPosters.includes(poster) ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain" decoding="async" loading={viewport.loading} fetchPriority={viewport.fetchPriority} onError={() => setFailedPosters((previous) => previous.includes(poster) ? previous : [...previous.slice(-7), poster])} /> : null}<span className="relative flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-black/65 shadow-lg"><Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden="true" /></span></button> : <div className="absolute inset-0 flex items-center justify-center text-sm text-white" role="status">{disabled ? 'Video ready to send' : 'Video unavailable'}</div>}
    </div>
  );
}
