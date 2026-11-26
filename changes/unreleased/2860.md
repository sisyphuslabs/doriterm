### Machine mesh

- One machine can be in several meshes: `DORITERM_PROFILE=<name>` (or the setup skill's `--profile <name>`) runs a
  separate host with its own keys, state dir, hc session and port, and every `doriface-host` command follows it.
  Profiles share the OS user, so they are not a security boundary between meshes. (#2858)
