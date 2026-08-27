# Production container images

Checkpoint 2 defines four application artifacts. Production deployments tag
each artifact with the Git commit SHA rather than `latest`:

- `void-api:<sha>`
- `void-vmd:<sha>`
- `void-gateway:<sha>`
- `void-web:<sha>`

Build them from the repository root:

```sh
SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short=12 HEAD)"

docker build \
  --build-arg APP_VERSION="$SHORT_SHA" \
  --build-arg VCS_REF="$SHA" \
  --tag "void-api:$SHORT_SHA" \
  VOID0000-api

docker build \
  --file VOID0000-api/Dockerfile.vmd \
  --build-arg APP_VERSION="$SHORT_SHA" \
  --build-arg VCS_REF="$SHA" \
  --tag "void-vmd:$SHORT_SHA" \
  VOID0000-api

docker build \
  --build-arg APP_VERSION="$SHORT_SHA" \
  --build-arg VCS_REF="$SHA" \
  --tag "void-gateway:$SHORT_SHA" \
  VOID0000-api/void_gateway

docker build \
  --build-arg APP_VERSION="$SHORT_SHA" \
  --build-arg VCS_REF="$SHA" \
  --build-arg VITE_API_URL= \
  --build-arg VITE_GATEWAY_URL= \
  --build-arg CDN_URL= \
  --tag "void-web:$SHORT_SHA" \
  VOID0000-www
```

The API artifact supports these role commands:

```text
node dist/server/entrypoints/account-server.js
node dist/server/entrypoints/message-server.js
node dist/server/entrypoints/social-server.js
node dist/server/entrypoints/conversation-server.js
node dist/server/entrypoints/worker-server.js
node dist/scripts/migrate.js
```

The API and VMD runtime images both run as fixed UID/GID `10001:10001` so the
message, worker, and VMD containers can later share the `0700` directories and
`0600` Unix sockets under `/run/voidapp`. The gateway also uses this fixed
non-root identity. The web image uses the Nginx unprivileged identity
`101:101` and listens on port `8080`.

The web image installs a frontend-only template at
`/etc/nginx/templates/default.conf.template`. The future deployment topology
can replace that file with `deploy/nginx/default.conf.template` to add internal
service routing without rebuilding the static frontend artifact.
