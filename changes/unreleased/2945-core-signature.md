### Host install

- Installing herdr-core (from the app or `doriface-host --install-hc`) now takes it only from Doriterm's mirror of the releases Doriterm signed, and checks that signature against the keys built into this version before downloading anything. A tampered download, one signed by anyone else, or an older version than the one installed is refused, and on a Mac herdr's own code signature is checked before the new binary first runs. (#2945)
