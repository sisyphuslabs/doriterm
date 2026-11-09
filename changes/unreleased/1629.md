### Host install

- The setup skill's `uninstall` removes the service even when the only herdr-core on the machine is older than the
  floor, since removing it never runs herdr-core. (#1204)
