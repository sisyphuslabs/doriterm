### Connection and offline wording

- `doriface-host` (the host, `connect` and `connect --mcp`) reaches the relay through the proxy the environment names
  (`WSS_PROXY`, `HTTPS_PROXY` or `ALL_PROXY`, minus `NO_PROXY`), so a machine or sandbox that only lets traffic out through
  a proxy, such as a cloud agent's VM, no longer fails every dial with 1006. A proxy that re-signs TLS needs its CA in
  `NODE_EXTRA_CA_CERTS`. (#2735)
