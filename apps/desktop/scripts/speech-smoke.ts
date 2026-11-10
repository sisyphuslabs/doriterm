import { createRequire } from "node:module";
import { join } from "node:path";
import { loadSpeech } from "../src/main/speech.ts";

/**
 * Loads the built dictation addon outside Electron and calls what needs no prompt: the exports exist, the status and
 * on-device answers have their types, and `ready()` is false here, since this process carries no usage strings (so the
 * app would leave dictation off rather than be ended by macOS). It never asks for a permission or opens the mic.
 */
const path = join(import.meta.dir, "..", "dist", "native", "speech.node");
const addon: unknown = createRequire(import.meta.url)(path);
const names = [
  "ready",
  "speechStatus",
  "requestSpeech",
  "noticeAuthorization",
  "supportsOnDevice",
  "start",
  "stop",
  "abort",
];
const missing = names.filter((name) => typeof Reflect.get(Object(addon), name) !== "function");
if (missing.length > 0) throw new Error(`speech.node lacks ${missing.join(", ")}`);
const call = (name: string, ...args: unknown[]): unknown =>
  Reflect.apply(Reflect.get(Object(addon), name), addon, args);
const ready = call("ready");
const status = call("speechStatus");
const noticeStatus = await call("noticeAuthorization");
const english = call("supportsOnDevice", "en-US");
const nonsense = call("supportsOnDevice", "zz-ZZ");
console.log(JSON.stringify({ ready, status, noticeStatus, english, nonsense }));
if (ready !== false) throw new Error("ready() must be false in a process without the usage strings");
if (!["granted", "denied", "restricted", "not-determined"].includes(String(status))) throw new Error("bad status");
if (!["granted", "denied", "not-determined", "unknown"].includes(String(noticeStatus))) {
  throw new Error("bad notification authorization");
}
if (typeof english !== "boolean" || nonsense !== false) throw new Error("bad supportsOnDevice answers");
if (loadSpeech(path) !== undefined) throw new Error("loadSpeech must refuse an app without the usage strings");
console.log("speech addon smoke: ok");
