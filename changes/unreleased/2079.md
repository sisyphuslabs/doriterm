### Host install

- `doriface-host --help` no longer offers "reach this host only directly" as a way to run the host: the direct
  path is off (#2070), so `--no-relay` and `--lan-listen` are labelled as the test knobs they are. Both keep
  working exactly as before. (#2075)

### Documentation

- The transport contract, the architecture notes and the README say that the direct path is off by decision and
  that every session goes through the relay, instead of describing it as a path no client happened to dial. (#2075)
