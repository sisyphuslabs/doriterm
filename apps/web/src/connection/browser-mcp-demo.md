# Browser MCP staging scope

The staging browser action lists terminals on the selected paired Doriterm host. It is a consumer of a client operation, not a separate terminal service. Pairing, host identity, the MCP switch, and revocation remain the host's responsibility.

The demo intentionally exposes only terminal listing: the staging proof needs one observable read and should not modify a user's machine. This is a UI omission, not a limit on SDK capabilities, a new security scope, or permission to add browser-only protocol behavior.

For an OmO integration, the typed SDK operation must exist before the UI, CLI, or agent tool exposes it. A missing operation belongs in the SDK; do not fill the gap with a CLI subprocess, a second device resolver, or raw transport in an adapter. Track any new OmO surface and its parity coverage in [omo#14943](https://github.com/code-yeongyu/oh-my-openagent/issues/14943).
