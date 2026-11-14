### Machine mesh

- `doriface-host mesh status` answers on macOS again. A reply larger than the control socket could take at once (about
  8 KB on macOS, so any mesh with a few members) was cut short, and the command waited for it until killed, printing
  nothing. The host now sends the whole reply before closing the connection.
