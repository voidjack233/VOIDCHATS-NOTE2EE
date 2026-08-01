# Web-to-mobile screen map

`VOID0000-www` remains the product and contract reference. The native client keeps its terminology and flows, while replacing desktop sidebars, tabs, and browser modals with stack navigation, dedicated screens, and mobile sheets.

| Web source | Native destination | Mobile adaptation |
| --- | --- | --- |
| `pages/Auth/Login.tsx` | `screens/auth/SignInScreen.tsx` | Full-screen sign-in with CAPTCHA and login-2FA continuation |
| `pages/Auth/Register.tsx` | `screens/auth/RegisterScreen.tsx` | Full-screen account creation with the current password policy |
| `pages/Auth/ForgotPassword.tsx` | `screens/auth/ForgotPasswordScreen.tsx` | CAPTCHA-backed reset request |
| `pages/Auth/ResetPassword.tsx` | `screens/auth/ResetPasswordScreen.tsx` | Token validation and password reset deep link |
| `pages/Auth/EmailVerification.tsx` | `screens/auth/EmailVerificationScreen.tsx` | Verification-token and code flow |
| `components/Auth/TwoFactorVerify.tsx` | `screens/auth/TwoFactorScreen.tsx` | Authenticator, email, and backup-code login challenge |
| `pages/Invite.tsx` | `screens/auth/InviteScreen.tsx` | Invite preview, auth continuation, request state, and group opening |
| `components/Chat/Conversation/ConversationList.tsx` | `screens/chat/HomeScreen.tsx` | Friends, DMs, and Groups are mobile segments on one hub screen |
| `components/common/Friends/*` | `screens/chat/HomeScreen.tsx`, `FriendProfileScreen.tsx` | Presence, requests, add-friend search, profiles, and DM creation |
| `components/Chat/MessageView/*`, `Messages/*` | `screens/chat/ChatScreen.tsx`, `components/chat/MessageItem.tsx` | Dedicated chat route with a simple inverted `FlatList`; no web timeline geometry |
| `components/Chat/Composer/MessageInput.tsx` | `components/chat/MessageComposer.tsx` | Multiline composer, media/files, spoilers, replies, edit state, slowmode, and role gates |
| `components/Chat/Conversation/ForwardMessageModal.tsx` | Chat forward modal | Native modal with conversation search |
| `components/Chat/Conversation/DirectConversationSettings.tsx` | `screens/chat/DirectSettingsScreen.tsx` | Dedicated mute/close-DM screen |
| `components/Chat/Groups/GroupCreateModal.tsx` | `screens/chat/CreateGroupScreen.tsx` | Dedicated creation screen with member selection and optional image |
| `components/Chat/Groups/ConversationSettings/ProfileTab.tsx` | Group Settings → Profile | Mobile section within `GroupSettingsScreen.tsx` |
| `components/Chat/Groups/ConversationSettings/MembersTab.tsx` | Group Settings → Members | Member list plus role, nickname, kick, transfer, and leave sheets |
| `components/Chat/Groups/ConversationSettings/InvitesTab.tsx` | Group Settings → Invites | Invite links and join requests in a scrollable section |
| `components/Chat/Groups/ConversationSettings/PermissionsTab.tsx` | Group Settings → Permissions | Owner controls using the existing permission fields |
| `components/common/Settings/SettingsModal.tsx` | `screens/settings/SettingsScreen.tsx` | Settings becomes a navigation menu rather than a desktop modal |
| `components/common/Settings/ProfileTab.tsx` | `ProfileSettingsScreen.tsx` | Profile fields and avatar picker |
| `components/common/Settings/AccountTab.tsx` | `AccountScreen.tsx` | Account identity and security entry points |
| `components/common/Settings/AppearanceTab.tsx` | `AppearanceScreen.tsx` | Live theme, density, spacing, and chat font preview |
| `components/common/Settings/NotificationsTab.tsx` | `NotificationsScreen.tsx` | Foreground sound preference and test; honest native-push status |
| `components/common/Settings/2FA/TwoFactorModal.tsx` | `TwoFactorSettingsScreen.tsx` | TOTP/email setup, disable, and backup-code management |
| `components/common/Settings/ActiveSessions/*` | `SessionsScreen.tsx` | Session list and revocation actions |
| `components/common/Settings/ChangePassword/*` | `ChangePasswordScreen.tsx` | Confirmation, 2FA, and current password-policy validation |
| `components/common/Settings/AboutTab.tsx` | `AboutScreen.tsx` | Native build metadata and legal navigation |

## Navigation shape

- Auth screens form the public stack; verification/reset/invite routes are also available to an authenticated deep link.
- Home is the authenticated root. A conversation pushes one dedicated Chat screen, and Back returns to Home.
- Friend profiles, group creation, direct/group settings, account settings, and security tools each push a mobile screen.
- Group Profile, Members, Invites, and Permissions use a single mobile settings screen with simple section navigation and bottom sheets for member actions.

## Timeline contract

The native timeline intentionally uses one newest-first data array with an inverted `FlatList`. The latest message renders at the visual bottom, `onEndReached` requests one older `before` page at the visual top, and history/realtime/outbox records reconcile by both server and client message IDs. Initial history stays still; only genuinely new incoming/outgoing rows use the specified 180 ms opacity and ±8 px entrance.
