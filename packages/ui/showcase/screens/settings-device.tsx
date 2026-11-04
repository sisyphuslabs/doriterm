import { useState } from "react";
import { Button, SettingRow, Switch } from "../../src/index.ts";
import { Group } from "./settings-sections.tsx";

export function DeviceSection() {
  const [awake, setAwake] = useState(true);
  return (
    <>
      <Group title="This device">
        <SettingRow
          inline
          title="Keep the screen awake"
          description="While a terminal is on screen. Released when you switch away."
          control={<Switch aria-label="Keep the screen awake" checked={awake} onCheckedChange={setAwake} />}
        />
        <SettingRow
          inline
          title="Install doriface"
          description="Opens in its own window, from the Dock or the home screen."
          control={<Button size="sm">Install</Button>}
        />
      </Group>
      <Group title="On iPhone and iPad">
        <SettingRow
          title="Add to Home Screen"
          description="In Safari, tap Share, then Add to Home Screen."
          control={null}
        />
      </Group>
    </>
  );
}
