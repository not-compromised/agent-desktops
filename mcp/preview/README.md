# Inert viewer preview

This preview serves the browser viewer against a frozen metadata snapshot and a captured image. Its transport has no WebSocket or input channel. It cannot control desktops or send chat messages.

Prepare an external data directory containing `fleet.json` with `hosts` and `desktops` arrays and `desktop.png` from an owned test desktop. The server copies display metadata only and replaces conversation and generation identifiers. Keep snapshots free of credentials and private content before sharing them.

```sh
PREVIEW_DATA=/absolute/path/to/snapshot PORT=8019 node mcp/preview/server.js
```

It binds loopback by default. `PREVIEW_BIND=bridge` selects the container's bridge address for a private gateway. Build the optional image from the repository root with `docker build -f mcp/preview/Dockerfile .`; mount the snapshot read-only and set `PREVIEW_DATA` to its container path. The image runs as the unprivileged node user and includes a health check.

Preview captures prove layout, navigation and saved view preferences. Real desktop pixels, input, audio and verified chat need separate runtime verification. The canonical check command includes the preview's metadata isolation and static resource tests.
