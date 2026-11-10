// Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1. This proves that the shipped addon loads
// into Electron and recognizes a local WAV; it does not prove microphone privacy, capture, or terminal insertion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const addon = createRequire(import.meta.url)(process.argv[2]);
for (const method of [
  "ready",
  "speechStatus",
  "requestSpeech",
  "supportsOnDevice",
  "start",
  "stop",
  "abort",
  "startFile",
]) {
  assert.equal(typeof addon[method], "function", method);
}
assert.equal(addon.ready(), true);
assert.equal(addon.speechStatus(), "granted");
assert.equal(await addon.requestSpeech(), "granted");
assert.equal(addon.supportsOnDevice("zz-ZZ"), false);
console.log(`PASS: packaged SAPI addon loads in Electron (${process.arch})`);

function session(language, file, cancel = false) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      addon.abort(id);
      reject(new Error("SAPI file recognition did not end within 30 seconds"));
    }, 30_000);
    const id = addon.startFile(language, file, (event) => {
      try {
        assert.equal(event.session, id);
        events.push(event);
        if (event.kind === "end") {
          clearTimeout(timer);
          resolve(events);
        }
      } catch (error) {
        clearTimeout(timer);
        addon.abort(id);
        reject(error);
      }
    });
    if (cancel) addon.abort(id);
  });
}

const unavailable = await session("zz-ZZ", "unused.wav");
assert.deepEqual(
  unavailable.map(({ kind }) => kind),
  ["error", "end"],
);
assert.equal(unavailable[0].code, "device-windows");
console.log("PASS: uninstalled language refuses offline and ends once");

if (!addon.supportsOnDevice("en-US")) {
  const message = `NOT PROVEN (${process.arch}): runner has no installed en-US desktop SAPI recognizer; WAV recognition and real microphone QA remain outstanding.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
} else {
  const directory = mkdtempSync(join(tmpdir(), "doriterm-sapi-"));
  try {
    const wav = join(directory, "speech.wav");
    const synthesized = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./speech-wav.ps1", import.meta.url)),
        "-Output",
        wav,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(synthesized.status, 0, synthesized.stderr || synthesized.error?.message);
    const events = await session("en-US", wav);
    assert.equal(events.filter(({ kind }) => kind === "end").length, 1);
    assert.deepEqual(
      events.filter(({ kind }) => kind === "error"),
      [],
    );
    const final = events.findLast((event) => event.kind === "result" && event.final);
    assert.ok(final && /test/i.test(final.text), "the WAV must produce a final transcript containing 'test'");
    console.log(`PASS: SAPI TTS WAV -> SetInput -> dictation grammar -> final text (${process.arch})`);
    const cancelled = await session("en-US", wav, true);
    assert.equal(cancelled.at(-1).kind, "end");
    assert.equal(cancelled.filter(({ kind }) => kind === "end").length, 1);
    assert.equal(
      cancelled.some((event) => event.kind === "result" && event.final),
      false,
    );
    console.log("PASS: abort ends the native session without a final transcript");
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Packaged ${process.arch} addon loaded and recognized a SAPI TTS WAV locally. Real microphone and terminal insertion still need Windows QA.\n`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
