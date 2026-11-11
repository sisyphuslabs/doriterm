import { expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "../connection/settings.ts";
import { useConnectionForm } from "./connection-section.tsx";

/** The settings the form opens on: loopback mode shows its Advanced fields, and another machine is already known. */
const OPENED: ConnectionSettings = {
  ...DEFAULT_SETTINGS,
  mode: "loopback",
  hostId: "a",
  hostName: "a",
  hostKey: "key-a",
  loopbackUrl: "ws://127.0.0.1:7766/v1/hc",
  token: "old",
};

/**
 * A store as the form sees it. `edit` merges the field it saved into the settings as they are now, and `select` moves the
 * shown machine as another row being picked does; no connection is dialled.
 */
function formStore(initial: ConnectionSettings) {
  let settings = initial;
  return {
    get settings() {
      return settings;
    },
    edit(fields: Partial<ConnectionSettings>) {
      settings = { ...settings, ...fields };
    },
    select(hostId: string) {
      settings = { ...settings, hostId };
    },
  };
}

/**
 * Mounts the form, types into an Advanced field, moves the shown machine, then saves the typed field: the sequence that
 * used to write the form's opening copy back and restore the older pick (#1006, #1169).
 */
function mountTypeMoveAndSave(): ConnectionSettings {
  const store = formStore(OPENED);
  let after = OPENED;
  function Probe() {
    const form = useConnectionForm(store);
    const [step, setStep] = useState(0);
    if (step === 0) {
      form.type("token", "fresh");
      setStep(1);
    } else if (step === 1) {
      store.select("b");
      setStep(2);
    } else if (step === 2) {
      form.commit("token", form.draft.token);
      after = store.settings;
      setStep(3);
    }
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return after;
}

test("saving an Advanced field keeps the machine another row selected while the form was open (#1169)", () => {
  const after = mountTypeMoveAndSave();
  expect(after.hostId).toBe("b");
  expect(after.token).toBe("fresh");
});
