### Workspace

- A tab whose program ended because its holder process died or the core stopped now goes by itself, as one that exited
  does, instead of waiting to be shown and then saying "This session ended" (#2986).
- Close tab on a pane that says "This session ended" always closes it, as does closing that tab, even after an earlier
  layout write was refused; if the layout still refuses the change, it says so again instead of doing nothing (#2986).
