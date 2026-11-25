### Host install

- The host keeps herdr-core current by itself: when it starts on an hc older than the version this release recommends (0.1.22) and hc is the user's own install, it runs `hc update` in the background. Terminals keep running through it, and the host checks that the new version reports and that every terminal is still there. Package-manager installs are left alone; set `DORIFACE_HC_AUTO_UPDATE=0` to turn it off. (#2812)
