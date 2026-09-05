# Container deployment

VOID uses one canonical single-host topology: [`compose.yaml`](../compose.yaml).
The production workflow, architecture, safety rules, and `voidctl` commands are
documented in [container-deployment.md](./container-deployment.md).

Use `voidctl` for normal lifecycle operations. It pins the Compose file and
project name, checks the selected runtime, preserves persistent volumes during
shutdown, and waits for aggregate readiness.

```bash
go build -C voidctl -trimpath -o bin/voidctl ./entrypoint
./voidctl/bin/voidctl setup --runtime docker
./voidctl/bin/voidctl doctor
./voidctl/bin/voidctl up
```

Do not use `docker compose down -v` for normal operations; that explicitly
deletes the persistent database and object-storage volumes.
