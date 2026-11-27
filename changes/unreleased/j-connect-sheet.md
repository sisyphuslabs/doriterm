### Machine mesh

- Connect a device is the one place to connect a phone, a browser or a computer. A phone or browser gets an invite as a
  QR code and a link that opens in any browser, and waits for your approval; a computer runs one command that joins
  without asking, or takes an invite it already has. It replaces Add machine and Add a browser or phone. (#2939)
- Asking for a phone's invite and then a computer's command in the same sheet no longer fails with "document is at
  version 2, not 1": the request is written again on a fresh read. (#2939)
