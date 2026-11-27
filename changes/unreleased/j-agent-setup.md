### Machine mesh

- Connect a device has an AI agent tab: OmO first, with a prompt that sets OmO up; then one prompt to paste into any
  agent that can run a command, and the config for Claude Code, Codex, Cursor or any other agent by hand. (#2939)
- The first connection of an AI agent now waits for your approval: the agent shows a code, and the approval card on any
  of your devices shows the same code and what approving gives. A denial or the invite running out leaves nothing
  paired, and `doriface-host connect` says so and exits with an error. (#2939)
