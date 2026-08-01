# VOID0000 Native

Expo + React Native mobile frontend for NOTE2EE. The native app follows the contracts and visual language in `../VOID0000-www` while using mobile-first navigation and a plain inverted `FlatList` for message history.

See [`docs/SCREEN_MAP.md`](docs/SCREEN_MAP.md) for the source web component behind every native screen and the mobile navigation adaptation.

## Run locally

This project targets [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/).

```bash
npm install
cp .env.example .env.local
npm start
```

Set `EXPO_PUBLIC_API_URL` to a reverse-proxy origin reachable from the device. `localhost` works for an iOS simulator, while an Android emulator normally uses `10.0.2.2`; a physical device needs the development machine's LAN address. The origin must route all `/api` services, not only the account service on port 3001.

Useful checks:

```bash
npm run typecheck
npx expo-doctor
npm run export:android
```

## Runtime contract

- REST authentication uses secure HttpOnly cookies. The app never stores access or refresh tokens in AsyncStorage.
- Authenticated mutations obtain a CSRF token and send `X-CSRF-Token`; refresh and CSRF retries are centralized in `src/services/api.ts`.
- The WebSocket gateway must receive the same cookie jar as REST. It identifies, heartbeats, resumes, and reconciles after reconnect.
- Native WebSockets send `EXPO_PUBLIC_GATEWAY_ORIGIN`, which must remain in the gateway Origin allow-list.
- Offline sends are persisted locally with their client message IDs and retried idempotently when connectivity returns.
- Invite, verification, and reset-password links support the `void0000://` scheme and the current web URL shapes.

For production, verify cookie and WebSocket sharing on both the final iOS and Android builds against the deployed domain. If a custom native networking stack is introduced later, it must preserve that shared-cookie behavior.

The native project registers iOS Associated Domains and Android App Links for `void0000.online`. Universal/App Link verification also requires the website to serve a matching `apple-app-site-association` file and `/.well-known/assetlinks.json` containing the final App Store/Play signing identifiers; those deployment files are intentionally outside this native-only change.

## Native push status

The current backend exposes browser Web Push only. The app does not claim background mobile push support: APNs, FCM, or Expo push-token registration requires a corresponding backend contract. Foreground realtime messages can play the bundled in-app sound when enabled and when the conversation is neither open nor muted.

## Main areas

- `src/context` — authenticated startup, cached bootstrap, lifecycle, and presence
- `src/services` — REST, CSRF/refresh, gateway, chat/social/profile, and outbox
- `src/screens/auth` — login, registration, captcha, verification, reset, and login 2FA
- `src/screens/chat` — Friends/DMs/Groups hub, dedicated chat, profiles, and group creation
- `src/screens/group` — group profile, members, invites, join requests, and permissions
- `src/screens/settings` — profile, account security, appearance, notifications, and about

See the versioned Expo documentation for [SafeAreaView](https://docs.expo.dev/versions/v57.0.0/sdk/safe-area-context/), [ImagePicker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/), [DocumentPicker](https://docs.expo.dev/versions/v57.0.0/sdk/document-picker/), and [Audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).
