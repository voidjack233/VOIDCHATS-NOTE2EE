# syntax=docker/dockerfile:1.7

ARG ELIXIR_IMAGE=elixir:1.16.3-otp-26-slim

FROM ${ELIXIR_IMAGE} AS build

ENV MIX_ENV=prod

WORKDIR /build

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && mix local.hex --force \
  && mix local.rebar --force

COPY mix.exs mix.lock ./
COPY config ./config

RUN mix deps.get --only prod \
  && mix deps.compile

COPY lib ./lib

RUN mix compile \
  && mix release

FROM debian:bookworm-slim AS runtime

ARG APP_VERSION=dev
ARG VCS_REF=unknown
ARG VOIDAPP_UID=10001
ARG VOIDAPP_GID=10001

LABEL org.opencontainers.image.title="VOID Gateway" \
  org.opencontainers.image.description="Phoenix realtime gateway release" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${VCS_REF}"

ENV LANG=C.UTF-8 \
  HOME=/app \
  ERL_CRASH_DUMP=/tmp/erl_crash.dump

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libncurses6 \
    libstdc++6 \
    openssl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid "${VOIDAPP_GID}" voidapp \
  && useradd --uid "${VOIDAPP_UID}" --gid "${VOIDAPP_GID}" \
    --no-create-home --home-dir /app --shell /usr/sbin/nologin voidapp

WORKDIR /app

COPY --from=build --chown=${VOIDAPP_UID}:${VOIDAPP_GID} /build/_build/prod/rel/void_gateway ./

USER ${VOIDAPP_UID}:${VOIDAPP_GID}

EXPOSE 4001

ENTRYPOINT ["/app/bin/void_gateway"]
CMD ["start"]
