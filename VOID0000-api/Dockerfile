# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2

FROM ${NODE_IMAGE} AS build

WORKDIR /build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    libcairo2-dev \
    libgif-dev \
    libjpeg62-turbo-dev \
    libpango1.0-dev \
    librsvg2-dev \
    make \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --legacy-peer-deps

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY server ./server

RUN npm run build \
  && find dist -type f -name '*.map' -delete \
  && npm prune --omit=dev --legacy-peer-deps \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ARG VOIDAPP_UID=10001
ARG VOIDAPP_GID=10001

ENV NODE_ENV=production \
  VOIDAPP_ROOT=/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libcairo2 \
    libgif7 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    librsvg2-2 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid "${VOIDAPP_GID}" voidapp \
  && useradd --uid "${VOIDAPP_UID}" --gid "${VOIDAPP_GID}" \
    --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin voidapp

ARG APP_VERSION=dev
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="VOID API" \
  org.opencontainers.image.description="Compiled VOID backend roles" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${VCS_REF}"

WORKDIR /app

COPY --from=build --chown=${VOIDAPP_UID}:${VOIDAPP_GID} /build/package.json /build/package-lock.json ./
COPY --from=build --chown=${VOIDAPP_UID}:${VOIDAPP_GID} /build/node_modules ./node_modules
COPY --from=build --chown=${VOIDAPP_UID}:${VOIDAPP_GID} /build/dist ./dist
COPY --chown=${VOIDAPP_UID}:${VOIDAPP_GID} db ./db
COPY --chown=${VOIDAPP_UID}:${VOIDAPP_GID} server/config.json ./server/config.json
COPY --chown=${VOIDAPP_UID}:${VOIDAPP_GID} server/utils/emails ./server/utils/emails

RUN mkdir -p /run/voidapp /app/server/routes/user/avatars \
  && chmod 0700 /run/voidapp \
  && chown -R "${VOIDAPP_UID}:${VOIDAPP_GID}" /run/voidapp /app/server/routes/user

USER ${VOIDAPP_UID}:${VOIDAPP_GID}

EXPOSE 3001 3002 3004 3005

CMD ["node", "dist/server/entrypoints/account-server.js"]
