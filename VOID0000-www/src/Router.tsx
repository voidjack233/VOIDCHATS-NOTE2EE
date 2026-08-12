import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './components/Auth/ErrorBoundary';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import { UserProvider, useUser } from './Services/Auth/UserContext';
import { canStartAuthenticatedProviders } from './Services/Auth/services/authStartupPolicy';
import { FriendProvider } from './Services/hooks/Friends/useFriendRequests';
import { PresenceProvider } from './Services/hooks/Friends/usePresence';
import { FriendsProvider } from './Services/hooks/Friends';
import { ThemeProvider, useThemeProvider } from './Services/hooks/Settings/useTheme';
import { useVersionCheck } from './Services/hooks/common/useVersionCheck';
import AppBootScreen from './components/common/AppBootScreen';
import QueuedSendRecoveryAgent from './components/Chat/QueuedSendRecoveryAgent';
import { loadChatPage } from './routeLoaders';

// Lazy-loaded pages
const Auth = lazy(() => import('./pages/Auth'));
const ResetPassword = lazy(() => import('./pages/Auth/ResetPassword'));
const Chat = lazy(loadChatPage);
const Invite = lazy(() => import('./pages/Invite'));
const TermsOfUse = lazy(() => import('./pages/TermsOfUse'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));

const ROUTE_CONFIG = {
  public: [
    { path: '/auth', component: Auth },
    { path: '/reset-password', component: ResetPassword },
    { path: '/invite/:code', component: Invite },
    { path: '/terms', component: TermsOfUse },
    { path: '/privacy', component: PrivacyPolicy },
  ],
  protected: [
    { path: '/chats', component: Chat },
    { path: '/chats/@me/:dmConversationId', component: Chat },
    { path: '/chats/:groupConversationId', component: Chat },
  ]
};

// Simplified ThemeWrapper to prevent context nesting issues
function ThemeWrapper({ children }: { children: React.ReactNode }) {
  const { user, loading, authUnavailable } = useUser();
  const authenticated = canStartAuthenticatedProviders({
    user,
    loading,
    authUnavailable,
  });
  const theme = useThemeProvider(authenticated);
  return <ThemeProvider value={theme}>{children}</ThemeProvider>;
}

function AuthenticatedProviders({ children }: { children: React.ReactNode }) {
  const { user, loading, authUnavailable } = useUser();
  const authenticated = canStartAuthenticatedProviders({
    user,
    loading,
    authUnavailable,
  });

  if (!authenticated) {
    return children;
  }

  return (
    <>
      <QueuedSendRecoveryAgent />
      <FriendsProvider>
        <FriendProvider>
          <PresenceProvider>
            {children}
          </PresenceProvider>
        </FriendProvider>
      </FriendsProvider>
    </>
  );
}

const PageLoader = () => <AppBootScreen />;

export default function Router() {
  useVersionCheck();

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return (
    <ErrorBoundary>
      <UserProvider>
        <ThemeWrapper>
          <AuthenticatedProviders>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                {/* Public routes */}
                {ROUTE_CONFIG.public.map(({ path, component: Component }) => (
                  <Route key={path} path={path} element={<Component />} />
                ))}

                {/* Protected routes */}
                {filteredProtectedRoutes()}

                {/* Redirects */}
                <Route path="/" element={<Navigate to="/chats" replace />} />
                <Route path="/home" element={<Navigate to="/chats" replace />} />
                <Route path="*" element={<Navigate to="/chats" replace />} />
              </Routes>
            </Suspense>
          </AuthenticatedProviders>
        </ThemeWrapper>
      </UserProvider>
    </ErrorBoundary>
  );
}

// Helper to keep the JSX clean
function filteredProtectedRoutes() {
  return ROUTE_CONFIG.protected.map(({ path, component: Component }) => (
    <Route
      key={path}
      path={path}
      element={
        <ProtectedRoute>
          <Component />
        </ProtectedRoute>
      }
    />
  ));
}
