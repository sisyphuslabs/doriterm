### MCP clients

- An MCP client can follow terminals as they change: terminals are MCP resources it can read and subscribe to
  (`subscriptions/listen`), and the MCP Events extension delivers `terminal.changed` with what changed
  (`events/stream`). Each subscription ends when it is cancelled or the session closes. (#2735)
