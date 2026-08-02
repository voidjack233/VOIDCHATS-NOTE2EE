import {
  DarkTheme,
  NavigationContainer,
  getStateFromPath as getDefaultStateFromPath,
  type LinkingOptions,
} from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { Screen } from '../components/common/Screen';
import { StateView } from '../components/common/StateView';
import { useAuth } from '../context/AuthContext';
import { EmailVerificationScreen } from '../screens/auth/EmailVerificationScreen';
import { ForgotPasswordScreen } from '../screens/auth/ForgotPasswordScreen';
import { InviteScreen } from '../screens/auth/InviteScreen';
import { LegalScreen } from '../screens/auth/LegalScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { ResetPasswordScreen } from '../screens/auth/ResetPasswordScreen';
import { SignInScreen } from '../screens/auth/SignInScreen';
import { TwoFactorScreen } from '../screens/auth/TwoFactorScreen';
import { ChatScreen } from '../screens/chat/ChatScreen';
import { CreateGroupScreen } from '../screens/chat/CreateGroupScreen';
import { DirectSettingsScreen } from '../screens/chat/DirectSettingsScreen';
import { FriendProfileScreen } from '../screens/chat/FriendProfileScreen';
import { HomeScreen } from '../screens/chat/HomeScreen';
import { GroupSettingsScreen } from '../screens/group/GroupSettingsScreen';
import { AboutScreen } from '../screens/settings/AboutScreen';
import { AccountScreen } from '../screens/settings/AccountScreen';
import { AppearanceScreen } from '../screens/settings/AppearanceScreen';
import { ChangePasswordScreen } from '../screens/settings/ChangePasswordScreen';
import { NotificationsScreen } from '../screens/settings/NotificationsScreen';
import { ProfileSettingsScreen } from '../screens/settings/ProfileSettingsScreen';
import { SessionsScreen } from '../screens/settings/SessionsScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { TwoFactorSettingsScreen } from '../screens/settings/TwoFactorSettingsScreen';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [
    'void0000://',
    'https://void0000.online',
    'https://www.void0000.online',
  ],
  config: {
    screens: {
      SignIn: 'auth',
      Register: 'register',
      ForgotPassword: 'forgot-password',
      EmailVerification: 'email-verification',
      ResetPassword: 'reset-password',
      Invite: 'invite/:code',
      Home: 'chats',
      Settings: 'settings',
    },
  },
  getStateFromPath(path, options) {
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    const [pathname, query = ''] = normalized.split('?');
    const search = new URLSearchParams(query);
    if (pathname === 'auth') {
      const view = search.get('view');
      if (view === 'register') return { routes: [{ name: 'Register' }] };
      if (view === 'forgot') return { routes: [{ name: 'ForgotPassword' }] };
      if (view === 'email-verification') {
        return { routes: [{ name: 'EmailVerification', params: { token: search.get('vtoken') || '' } }] };
      }
      if (view === 'reset-password') {
        return { routes: [{ name: 'ResetPassword', params: { token: search.get('token') || undefined } }] };
      }
    }
    if (pathname === 'terms' || pathname === 'privacy') {
      return { routes: [{ name: 'Legal', params: { document: pathname } }] };
    }
    return getDefaultStateFromPath(path, options);
  },
};

function BootState() {
  const { status, cachedUser, retry, isLoggingOut } = useAuth();
  if (isLoggingOut) {
    return <Screen><StateView message="Clearing this device's session..." title="Signing you out..." type="loading" /></Screen>;
  }
  if (status === 'unavailable') {
    return (
      <Screen>
        <StateView
          actionLabel="Retry"
          message={cachedUser
            ? 'Account service is unavailable. Your login is preserved and will be retried.'
            : 'The server is not responding yet. Check your connection and retry.'}
          onAction={() => void retry()}
          title="Reconnecting to server..."
          type="offline"
        />
      </Screen>
    );
  }
  return <Screen><StateView message="Checking your session..." title="Preparing..." type="loading" /></Screen>;
}

export function RootNavigator() {
  const { status, user } = useAuth();
  const { palette } = useTheme();
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);
  const [pendingInviteChecked, setPendingInviteChecked] = useState(false);

  useEffect(() => {
    if (status !== 'authenticated') {
      setPendingInvite(null);
      setPendingInviteChecked(false);
      return;
    }
    let active = true;
    void AsyncStorage.getItem('void_pending_invite').then(async (code) => {
      if (!active) return;
      setPendingInvite(code?.trim() || null);
      setPendingInviteChecked(true);
      if (code) await AsyncStorage.removeItem('void_pending_invite');
    }).catch(() => {
      if (active) setPendingInviteChecked(true);
    });
    return () => {
      active = false;
    };
  }, [status, user?.id]);
  const navigationTheme = useMemo(() => ({
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: palette.accent,
      background: palette.bg,
      card: palette.surface,
      text: palette.text,
      border: palette.border,
      notification: palette.danger,
    },
  }), [palette]);

  if (status === 'checking' || status === 'unavailable') return <BootState />;
  const authenticated = status === 'authenticated';
  if (authenticated && !pendingInviteChecked) return <BootState />;

  return (
    <NavigationContainer linking={linking} theme={navigationTheme}>
      <Stack.Navigator
        initialRouteName={authenticated && pendingInvite ? 'Invite' : authenticated ? 'Home' : 'SignIn'}
        key={authenticated ? `authenticated-${pendingInvite || 'home'}` : 'public'}
        screenOptions={{
          animation: Platform.OS === 'android' ? 'fade' : 'slide_from_right',
          contentStyle: { backgroundColor: palette.bg },
          headerShown: false,
        }}
      >
        {authenticated ? (
          <>
            <Stack.Screen component={HomeScreen} name="Home" />
            <Stack.Screen component={ChatScreen} name="Chat" />
            <Stack.Screen component={CreateGroupScreen} name="CreateGroup" />
            <Stack.Screen component={FriendProfileScreen} name="FriendProfile" />
            <Stack.Screen component={SettingsScreen} name="Settings" />
            <Stack.Screen component={ProfileSettingsScreen} name="ProfileSettings" />
            <Stack.Screen component={AccountScreen} name="AccountSettings" />
            <Stack.Screen component={AppearanceScreen} name="AppearanceSettings" />
            <Stack.Screen component={NotificationsScreen} name="NotificationsSettings" />
            <Stack.Screen component={AboutScreen} name="AboutSettings" />
            <Stack.Screen component={SessionsScreen} name="ActiveSessions" />
            <Stack.Screen component={ChangePasswordScreen} name="ChangePassword" />
            <Stack.Screen component={TwoFactorSettingsScreen} name="TwoFactorSettings" />
            <Stack.Screen component={DirectSettingsScreen} name="DirectSettings" />
            <Stack.Screen component={GroupSettingsScreen} name="GroupSettings" />
            <Stack.Screen component={InviteScreen} initialParams={pendingInvite ? { code: pendingInvite } : undefined} name="Invite" />
            <Stack.Screen component={EmailVerificationScreen} name="EmailVerification" />
            <Stack.Screen component={ResetPasswordScreen} name="ResetPassword" />
            <Stack.Screen component={LegalScreen} name="Legal" />
          </>
        ) : (
          <>
            <Stack.Screen component={SignInScreen} name="SignIn" />
            <Stack.Screen component={RegisterScreen} name="Register" />
            <Stack.Screen component={ForgotPasswordScreen} name="ForgotPassword" />
            <Stack.Screen component={EmailVerificationScreen} name="EmailVerification" />
            <Stack.Screen component={ResetPasswordScreen} name="ResetPassword" />
            <Stack.Screen component={TwoFactorScreen} name="TwoFactor" />
            <Stack.Screen component={InviteScreen} name="Invite" />
            <Stack.Screen component={LegalScreen} name="Legal" />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
