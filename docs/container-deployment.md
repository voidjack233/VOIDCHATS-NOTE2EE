# Single-host container deployment

`compose.yaml` is the sole canonical production topology. Pass it explicitly in
manual automation or use `voidctl`, which always selects it and the configured
project name.

## Architecture

- `edge` serves the built web client and is the only service with a host port.
- `account`, `message`, `social`, and `conversation` are roles from one compiled
  Node image tagged with the deployed Git SHA.
- `worker` owns the attachment sanitizer and VMD transform Unix sockets. Worker
  and message readiness perform protocol-level pings rather than accepting a
  socket connection as proof of readiness.
- `vmd` is the static Go media delivery image; `gateway` is the Phoenix release.
- PostgreSQL, Scylla, Valkey, and MinIO use named persistent volumes.
- `volume-init`, `minio-init`, and `migrate` are idempotent one-shot services.
- Application roles cannot start until migrations succeed. Message and VMD
  readiness also verify their required worker IPC socket.
- Data, edge, and outbound networks are separate. Only services with a concrete
  outbound requirement join the outbound network; the edge also joins it so
  Docker can establish its host NAT binding. PostgreSQL, Scylla, Valkey, and
  internal application ports are never published to the host.

## First setup

Build the host CLI and select exactly one container runtime:

```bash
go build -C voidctl -trimpath -o bin/voidctl ./entrypoint
./voidctl/bin/voidctl setup --runtime docker
./voidctl/bin/voidctl doctor
```

`setup` creates `deploy/.env` with mode `0600` and stores the runtime selection
in `.voidctl/runtime`. Both are ignored by Git. Re-running setup preserves
existing secrets. Selecting another runtime requires another explicit
`setup --runtime ...`; no later command silently switches engines.

The generated URLs default to `http://127.0.0.1:8080`. Set the public origins,
edge bind address, cookie domain, email credentials, and VAPID values in
`deploy/.env` before an Internet deployment. Keep `CDN_URL` equal to the origin
through which `/avatars`, `/group-avatars`, and signed `/chat-attachments` are
served so MinIO signatures retain the expected host.

## Lifecycle

```bash
./voidctl/bin/voidctl up
./voidctl/bin/voidctl status
./voidctl/bin/voidctl logs -f message worker
./voidctl/bin/voidctl restart
./voidctl/bin/voidctl down
```

`up` refuses tracked Git changes, updates the image tag to the current commit,
builds the four production images sequentially to bound compiler memory, starts
the topology, and waits for aggregate `READY`. `down` never passes `--volumes`
or `-v`; named data volumes survive normal shutdown and restart.

`GET /health` is edge liveness. `GET /ready` exposes account-service readiness
for load balancers that need an HTTP upstream probe; it is not aggregate stack
readiness. `voidctl status` is authoritative for the whole topology.

Status meanings:

- `RUNNING`: startup is still in progress or a health check has not settled.
- `READY`: every long-lived service is healthy and every initializer/migration
  completed with exit code zero.
- `DEGRADED`: all services run, but at least one reports unhealthy.
- `FAILED`: a required service is absent/exited or a one-shot task failed.
- `STOPPED`: this Compose project has no containers.

## Secrets

This single-host version injects values from the mode-`0600` `deploy/.env`
file. Application libraries currently require normal environment variables, so
the values are visible to a sufficiently privileged local operator through
container inspection. They are never baked into images, committed, or printed
by `voidctl`. File-backed container secrets can replace this later after the
applications support `*_FILE` settings.

## Docker and Podman

Docker Engine with the Compose plugin is the tested runtime. `voidctl` also
supports `podman compose` and `podman-compose` without maintaining a second
topology. Rootless Podman DNS, health-condition behavior, and host networking
must be verified on the target host before calling Podman production-ready.
When Podman is unavailable, `voidctl runtime` reports it as unavailable rather
than claiming tested support.

## Safety notes

- Do not use `compose down -v` for normal lifecycle operations.
- Changing database credentials in `deploy/.env` does not rewrite credentials
  already initialized inside persistent volumes.
- MinIO avatar buckets are public-read; attachment and VMD cache buckets are
  private. Only signed attachment paths and VMD capabilities are routed.
- Infrastructure and application build-base images are pinned by digest.
  Application outputs use local immutable Git-SHA tags; no production service
  uses `latest`.
