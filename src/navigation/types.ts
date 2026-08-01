import type { Conversation, Profile, TwoFactorChallenge } from '../types/models';

export type RootStackParamList = {
  SignIn: { pendingInvite?: string } | undefined;
  Register: undefined;
  ForgotPassword: undefined;
  EmailVerification: { token: string };
  ResetPassword: { token?: string } | undefined;
  TwoFactor: { challenge: TwoFactorChallenge };
  Legal: { document: 'terms' | 'privacy' };
  Invite: { code: string };

  Home: undefined;
  Chat: { conversation: Conversation };
  Friends: undefined;
  FriendProfile: { profileId: string; initial?: Profile };
  CreateGroup: undefined;
  Settings: undefined;
  ProfileSettings: undefined;
  AccountSettings: undefined;
  AppearanceSettings: undefined;
  NotificationsSettings: undefined;
  AboutSettings: undefined;
  ActiveSessions: undefined;
  ChangePassword: undefined;
  TwoFactorSettings: undefined;
  DirectSettings: { conversation: Conversation };
  GroupSettings: { conversation: Conversation };
  GroupProfile: { conversation: Conversation };
  GroupMembers: { conversation: Conversation };
  GroupInvites: { conversation: Conversation };
  GroupPermissions: { conversation: Conversation };
};
