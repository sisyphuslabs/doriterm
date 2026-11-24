### MCP clients

- An MCP client now sees one tool, `doriterm`, which runs any Doriterm command the way the `hc` CLI takes it (`["ls"]`,
  `["send","t3","hi"]`, `["file","read","/etc/hostname"]`, `["mesh","status"]`). The Doriterm skill comes attached as its
  manual, as MCP resources and a prompt. Commands that need a person (attach, stopping the core, removing a machine) and
  any path into the host's private state are refused. `doriface-host connect --mcp` no longer takes `--tools`. (#2789)
