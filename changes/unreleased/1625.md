### Host install

- install.sh hands the mesh link to `mesh join` in a file only you can read, never on its command line where
  other local users can read it, and `DORIFACE_JOIN=<link>` joins like `--join` with the link off the installer's
  own command line. (#1201)
