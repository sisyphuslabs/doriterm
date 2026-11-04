/**
 * The label End puts on a terminal together with its kill: remove this terminal once its program has finished. hc
 * never interprets labels; doriface-host removes every finished terminal carrying it, so an End whose page closes
 * before its own terminal.rm goes out still removes the terminal. herdr.-prefixed like `herdr.name`, per herdr-app's
 * label rules (docs/labels.md, "Adding more"), so every herdr client can read it.
 */
export const END_LABEL = "herdr.end";
