### MCP clients

- MCP is on by default: a paired device can open an MCP session on a host that never set the switch, new installs
  and existing hosts alike. `doriface-host mcp off` still turns it off, and that setting survives updates; an unpaired
  or revoked device is still refused. (#2735)
