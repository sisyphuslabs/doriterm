import type { HcConnection } from "@doriface/client";
import { NOTICE_EVENTS, type NoticeEvent, type PushPrefs, type Terminal } from "@doriface/protocol";
import { Button, Notice, SettingRow, Switch, groupHeadingClass } from "@doriface/ui";
import { useEffect, useSyncExternalStore } from "react";
import { useConnection } from "../connection/store.ts";
import { type DesktopNotices, desktopNotices } from "../push/desktop-notices.ts";
import { pushSettings, type PushView } from "../push/push-settings.ts";
import { idOfMachine } from "../workspace/model.ts";
import { useMachines } from "../workspace/use-machines.ts";
import { noticeControls } from "./notice-controls.ts";

const NO_TERMINALS: readonly Terminal[] = [];

const EVENT_ROWS: Readonly<Record<NoticeEvent, { readonly title: string; readonly description: string }>> = {
  input: { title: "An agent asks for input", description: "It stopped to ask you something." },
  permission: {
    title: "An agent asks for permission",
    description: "With Allow and Deny on the notification where this device shows them.",
  },
  done: { title: "An agent finishes its turn", description: "It is done and waiting for what comes next." },
  error: { title: "An agent stops with an error", description: "Its turn ended in an error." },
};

const UNSUPPORTED: Readonly<Record<Exclude<PushView["support"], "supported">, { title: string; body: string }>> = {
  "install-first": {
    title: "Add Doriterm to your Home Screen first",
    body: "On iPhone and iPad, notifications work in the installed app. In Safari, tap Share, then Add to Home Screen, and turn notifications on from there.",
  },
  "desktop-app": {
    title: "This computer cannot show notifications",
    body: "Doriterm found no notification service on this system. On Linux, start your desktop's notification daemon, then come back here.",
  },
  unsupported: {
    title: "This browser cannot show notifications from Doriterm",
    body: "Open Doriterm in a current Chrome, Edge, Firefox or Safari to turn them on.",
  },
};

/** Web push or, in the desktop app, its native notifications: one Settings section drives either. */
type NoticeSettings = Pick<DesktopNotices, "subscribe" | "view" | "load" | "turnOn" | "turnOff" | "setPrefs" | "test">;
const settings: NoticeSettings = desktopNotices ?? pushSettings;
const desktop = desktopNotices !== null;

const REMEDY =
  "Allow Doriterm in your system's notification settings (on macOS: System Settings > Notifications > Doriterm), then check again.";

/** The agents in a wanted state as the feed last told, kept live: the trigger announces changes, never a state already held. */
function waitingText(view: PushView): string {
  if (view.waiting === null) return "";
  if (view.waiting === 0) return " No agent is waiting right now; you hear about changes from now on.";
  const agents = view.waiting === 1 ? "1 agent is" : `${view.waiting} agents are`;
  return ` ${agents} already waiting and will not be announced again; you hear about changes from now on.`;
}

function desktopStatusText(view: PushView): string {
  if (view.permission === "denied")
    return `Blocked by this computer: it does not show Doriterm's notifications. ${REMEDY}`;
  if (!view.on) {
    return view.permission === "default"
      ? "Hear when an agent asks for input or permission, finishes, or stops with an error, while Doriterm runs. This computer asks whether to allow them when the first one is shown."
      : "Hear when an agent asks for input or permission, finishes, or stops with an error, while Doriterm runs.";
  }
  const shown =
    view.permission === "granted"
      ? "On. This computer allows Doriterm's notifications; you hear about agents while Doriterm runs, even with its window in the background."
      : view.permission === "default"
        ? "On. This computer asks whether to allow Doriterm's notifications when the first one is shown."
        : `On. This computer decides whether Doriterm's notifications appear. If none do, ${REMEDY.charAt(0).toLowerCase()}${REMEDY.slice(1)}`;
  return shown + waitingText(view);
}

function statusText(view: PushView): string {
  if (desktop) return desktopStatusText(view);
  if (view.on) return "On. You hear about agents even with Doriterm closed.";
  if (view.permission === "denied") {
    return "Blocked for this site. Allow notifications in this browser's site settings, then come back here.";
  }
  return "Hear when an agent asks for input or permission, finishes, or stops with an error, even with Doriterm closed.";
}

function MachineMutes({
  connection,
  prefs,
  disabled,
}: {
  readonly connection: HcConnection;
  readonly prefs: PushPrefs;
  readonly disabled: boolean;
}) {
  const { views } = useMachines(connection, NO_TERMINALS);
  const machines = [
    { id: idOfMachine(undefined), name: connection.hello.core.name },
    ...views.map((view) => ({ id: idOfMachine(view.name), name: view.name })),
  ];
  const setMuted = (id: string, heard: boolean): void => {
    const muted = heard ? prefs.muted.filter((entry) => entry !== id) : [...prefs.muted, id];
    void settings.setPrefs({ ...prefs, muted });
  };
  return (
    <ul aria-label="Machines" className="flex flex-col">
      {machines.map((machine) => (
        <li key={machine.id}>
          <SettingRow
            inline
            title={
              <span className="block truncate" title={machine.name}>
                {machine.name}
              </span>
            }
            control={
              <Switch
                aria-label={`Notifications from ${machine.name}`}
                data-push-machine={machine.id}
                disabled={disabled}
                checked={!prefs.muted.includes(machine.id)}
                onCheckedChange={(heard) => setMuted(machine.id, heard)}
              />
            }
          />
        </li>
      ))}
    </ul>
  );
}

/** Settings > Notifications: the permission is asked for only from Turn on. */
export function NotificationsSection() {
  const view = useSyncExternalStore(settings.subscribe, () => settings.view);
  const state = useConnection();
  useEffect(() => {
    void settings.load();
  }, []);
  if (view.support !== "supported") {
    const reason = UNSUPPORTED[view.support];
    return (
      <div data-push-state={view.support}>
        <Notice tone="info" title={reason.title}>
          {reason.body}
        </Notice>
      </div>
    );
  }
  const blocked = view.permission === "denied";
  const controls = noticeControls(view, desktop);
  const off = !controls.editable;
  const setEvent = (event: NoticeEvent, on: boolean): void =>
    void settings.setPrefs({ ...view.prefs, events: { ...view.prefs.events, [event]: on } });
  return (
    <div className="flex flex-col gap-6" data-push-state={blocked ? "blocked" : view.on ? "on" : "off"}>
      <div className="flex flex-col">
        <SettingRow
          title="Notifications on this device"
          description={statusText(view)}
          control={
            <div className="flex gap-2">
              {controls.actions.map((action) =>
                action === "check-again" ? (
                  <Button
                    key={action}
                    loading={controls.running === action}
                    disabled={view.busy !== null}
                    onClick={() => void settings.load()}
                  >
                    Check again
                  </Button>
                ) : action === "turn-off" ? (
                  <Button
                    key={action}
                    loading={controls.running === action}
                    disabled={view.busy !== null}
                    onClick={() => void settings.turnOff()}
                  >
                    Turn off
                  </Button>
                ) : (
                  <Button
                    key={action}
                    variant="primary"
                    loading={controls.running === action}
                    disabled={controls.turnOnDisabled}
                    onClick={() => void settings.turnOn()}
                  >
                    Turn on
                  </Button>
                ),
              )}
            </div>
          }
        />
        <SettingRow
          title="Send a test notification"
          description={
            view.tested
              ? "Sent. It should appear in a moment."
              : desktop
                ? "Runs the checks an agent's notification passes, whichever machine it runs on, then shows one."
                : "Checks that this device gets them."
          }
          control={
            <Button disabled={off} loading={controls.running === "test"} onClick={() => void settings.test()}>
              Send test
            </Button>
          }
        />
      </div>
      {view.error === null ? null : (
        <Notice tone="error" title="Notifications">
          {view.error}
        </Notice>
      )}
      {view.retry === null ? null : (
        <Notice tone="warning" title="Following the agents again">
          {`Could not follow the agents: ${view.retry.reason}. Trying again in ${Math.ceil(view.retry.inMs / 1000)} s.`}
        </Notice>
      )}
      <section aria-labelledby="push-events" className="flex flex-col">
        <h3 id="push-events" className={groupHeadingClass}>
          Notify me when
        </h3>
        {NOTICE_EVENTS.map((event) => (
          <SettingRow
            key={event}
            inline
            title={EVENT_ROWS[event].title}
            description={EVENT_ROWS[event].description}
            control={
              <Switch
                aria-label={EVENT_ROWS[event].title}
                data-push-event={event}
                disabled={off}
                checked={view.prefs.events[event]}
                onCheckedChange={(on) => setEvent(event, on)}
              />
            }
          />
        ))}
      </section>
      {state.phase === "open" ? (
        <section aria-labelledby="push-machines" className="flex flex-col">
          <h3 id="push-machines" className={groupHeadingClass}>
            From these machines
          </h3>
          <MachineMutes connection={state.connection} prefs={view.prefs} disabled={off} />
        </section>
      ) : null}
      <p className="text-prose text-pretty text-muted-foreground">
        {desktop
          ? "A notification carries no command or output. Clicking one opens the session it is about."
          : "A notification carries no command or output. When you open one, your host tells this device which session it is about over the encrypted connection."}
      </p>
    </div>
  );
}
