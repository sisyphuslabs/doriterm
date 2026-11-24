### MCP clients

- An MCP client can do what a paired phone does with the mesh: read its members, devices and waiting joins, open an
  invite, approve or deny a join with its six digits, rename or revoke a member, unpair a device, and leave. A revoke
  or a leave answers a preview first and is written only when called again with `yes`. (#2735)
