# macOS Bridge

The CLI includes an internal macOS bridge for browser-based auth flows started inside devcontainers.

## What it does

- injects `BROWSER` and `xdg-open` shims into new containers created by `devcontainer up`
- starts a hidden host-side bridge process on macOS
- forwards loopback listeners from the container back to `127.0.0.1` on the host when possible
- rewrites browser-opened `localhost` URLs to the forwarded host port when an exact port cannot be claimed

This is intended to make flows like OAuth callbacks work for tools running inside the container.

## Important distinction

There are two auth patterns:

- tool opens the browser itself using `xdg-open` or `BROWSER`
- tool prints a URL and waits for a callback on `localhost`

For the first case, the bridge can rewrite the URL before it reaches the host browser.

For the second case, the host must actually be listening on the callback port. The bridge tries to bind the same host port first. If that host port is already busy, it falls back to another port, which means a manually copied `localhost:<port>` callback URL may not work as-is.

## Bridge status

Use:

```sh
devcontainer doctor --workspace-folder <path>
```

This reports:

- whether the bridge supervisor is running
- the bridge control port
- the session status file
- the last bridge event or error
- forwarded container ports and whether they were bound on the exact same host port

## Current limitations

- macOS only
- applies to containers created through `devcontainer up`
- reused containers are supported, but existing non-bridge containers are not retrofitted
- exact host port binding is best-effort; if the host port is occupied, the bridge falls back to another port
- generic loopback forwarding still depends on `nc`, `python`, `python3`, or `bash` being available inside the container
