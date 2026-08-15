import { markStartupPerformance, markStartupPerformanceOnce } from './Services/Performance/startupPerformance';

type ChatPageModule = typeof import('./pages/Chat/Chats');

let chatPagePromise: Promise<ChatPageModule> | null = null;
let loadedChatPageModule: ChatPageModule | null = null;

export function isDefaultAuthenticatedChatPath(pathname: string): boolean {
  return pathname === '/' ||
    pathname === '/home' ||
    pathname === '/chats' ||
    pathname.startsWith('/chats/');
}

export function loadChatPage(): Promise<ChatPageModule> {
  if (loadedChatPageModule) return Promise.resolve(loadedChatPageModule);
  if (chatPagePromise) return chatPagePromise;

  markStartupPerformanceOnce('chat-route-load-start');
  const request = import('./pages/Chat/Chats')
    .then((module) => {
      loadedChatPageModule = module;
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

export function getLoadedChatPage(): ChatPageModule | null {
  return loadedChatPageModule;
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
