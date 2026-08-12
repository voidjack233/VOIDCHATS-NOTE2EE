import { markStartupPerformance, markStartupPerformanceOnce } from './Services/Performance/startupPerformance';

type ChatPageModule = typeof import('./pages/Chat/Chats');

let chatPagePromise: Promise<ChatPageModule> | null = null;

export function isDefaultAuthenticatedChatPath(pathname: string): boolean {
  return pathname === '/' ||
    pathname === '/home' ||
    pathname === '/chats' ||
    pathname.startsWith('/chats/');
}

export function loadChatPage(): Promise<ChatPageModule> {
  if (chatPagePromise) return chatPagePromise;

  markStartupPerformanceOnce('chat-route-load-start');
  const request = import('./pages/Chat/Chats')
    .then((module) => {
      markStartupPerformanceOnce('chat-route-load-end');
      return module;
    })
    .catch((error) => {
      if (chatPagePromise === request) chatPagePromise = null;
      markStartupPerformance('chat-route-load-failed');
      throw error;
    });
  chatPagePromise = request;
  return request;
}

export async function preloadDefaultAuthenticatedChatRoute(
  pathname = globalThis.location?.pathname || '',
): Promise<boolean> {
  if (!isDefaultAuthenticatedChatPath(pathname)) return false;
  markStartupPerformanceOnce('chat-route-preload-start');
  try {
    await loadChatPage();
    return true;
  } catch {
    return false;
  }
}
