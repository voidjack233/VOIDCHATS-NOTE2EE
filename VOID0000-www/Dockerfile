# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2

FROM ${NODE_IMAGE} AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --legacy-peer-deps

COPY . .

ARG VITE_API_URL=
ARG VITE_GATEWAY_URL=
ARG CDN_URL=

ENV VITE_API_URL=${VITE_API_URL} \
  VITE_GATEWAY_URL=${VITE_GATEWAY_URL} \
  CDN_URL=${CDN_URL}

RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine@sha256:c97ff0bf7cbae369953c6da1232ec14ad9f971d66360c5698db0856a4cd657a0 AS runtime

ARG APP_VERSION=dev
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="VOID Web" \
  org.opencontainers.image.description="VOID frontend served by Nginx" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${VCS_REF}"

ENV VOID_WEB_PORT=8080 \
  VOID_WEB_SERVER_NAME=_ \
  NGINX_ENVSUBST_FILTER='^VOID_WEB_'

COPY --chown=101:101 docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=101:101 /build/dist /usr/share/nginx/html

USER 101:101

EXPOSE 8080
