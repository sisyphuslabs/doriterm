### Workspace

- A space the app makes for a terminal no tab shows (a lane an agent opens for new work) is now named after the work
  itself, its directory or the program it started, and only an existing Home space still takes them as before, instead
  of every such terminal landing in a generic Home. (#2670)
- A tab that is not an agent's own, a lane's above all, now reads the lane's name, or the title of the program it runs,
  from the first tab on. The label truncates with its whole title on hover, and only a pane that names nothing keeps
  its place as a number. (#2670)

### Phone

- The Type field no longer draws a thin unlabeled bar down its right edge: the idle pill fits its one line exactly,
  where it used to be 2 px too short for it and so drew a scroll strip inside itself. (#2670)
