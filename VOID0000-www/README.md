# VOID Frontend

This folder is the React frontend for VOID.

It is the part users actually touch, so a lot of the weirdness here comes from trying to make complicated chat behavior feel normal: realtime updates, old-history scrolling, failed media, group membership changes, and all the little UI states between them.

If you are trying to understand or run the project, start here first:

- [../README.md](../README.md)
- [../docs/setup.md](../docs/setup.md)

Frontend-specific notes:

- [docs/project-flow-map.md](docs/project-flow-map.md)
- [docs/message-scroll-mechanism.md](docs/message-scroll-mechanism.md)

## Frontend Shape

- `src/pages/Chat` owns the main chat page shell.
- `src/components/Chat/MessageView` owns the message timeline, history loading, jump-to-present behavior, and viewport restoration.
- `src/components/Chat/Messages` owns message rows, bubbles, reactions, link previews, formatting, and layout decisions.
- `src/components/Chat/Composer` owns the message composer and send controls.
- `src/components/Chat/Groups` owns group settings, members, invites, permissions, ownership transfer, and leaving/deleting group flows.

Group settings expose the sections that have real behavior:

- `Profile`
- `Members`
- `Invites`
- `Permissions`

Basic owner/admin/member roles exist inside the app, but there is no custom role-builder UI in this repo.

## Message Runtime Note

- messages are sent to the backend as normal service data
- the backend stores message history in ScyllaDB and conversation metadata in Postgres
- private attachments are uploaded to object storage and downloaded through authenticated API routes
- realtime delivery comes through the Phoenix gateway and Valkey pub/sub
- local browser storage is used for UI state, cached conversation data, queued sends, and settings

## Multi-Service Dev Note

- in development, Vite proxies message, conversation, social/profile, account, and gateway paths to different local services
- in production, the frontend still points at one API hostname, so the deploy tunnel/reverse proxy must split those paths correctly

## Frontend Commands

```bash
npm install
npm run dev
```

```bash
npm run build
```
