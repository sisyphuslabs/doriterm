/// <reference lib="webworker" />
// The browser's vault keyholder: the device key and every tier key it opens live only in this worker. The page asks it
// to open, seal and wrap; it never sends a key back.
import { localKeyholder, serveKeyholder } from "@doriface/vault";
import { deviceStore } from "../storage/idb.ts";
import { answerOn } from "./vault-channel.ts";
import { loadVaultKey } from "./vault-key.ts";

const serve = loadVaultKey(deviceStore, self.crypto.subtle).then((key) => serveKeyholder(localKeyholder(key)));
answerOn(self, serve);
