### Machine mesh

- A `doriface-host` command that asks the running host (`mesh status`, `mesh revoke`, `pair`, ...) no longer waits
  forever when the host does not answer: after its deadline it says the running host did not answer and exits non-zero.
  `mesh join` and a join waiting for its joiner still wait for the person.
