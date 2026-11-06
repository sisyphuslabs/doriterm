import type { CapacitorConfig } from "@capacitor/cli";

/** The iOS and Android apps load the web build unchanged (#704); only push and the shell around it are native. */
const config: CapacitorConfig = {
  appId: "dev.omo.doriface",
  appName: "doriface",
  webDir: "../web/dist",
  android: { allowMixedContent: false },
  ios: { contentInset: "never" },
};

export default config;
