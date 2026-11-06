import { Button, Notice } from "@doriface/ui";
import { RotateCcw } from "lucide-react";
import { currentPlatform } from "../keys/trigger.ts";
import { resetKeys } from "../keybar/operations.ts";
import { useKeyBarError, useKeyBarSettings, keyBarStore } from "../keybar/store.ts";
import { asSentence } from "../storage/sentence.ts";
import { FavoriteKeys } from "./favorite-keys.tsx";
import { KeyBarPreview } from "./key-bar-preview.tsx";
import { KeyOrderList, KeyRestoreList } from "./key-order-list.tsx";
import { PackList } from "./pack-list.tsx";

function Group({
  id,
  title,
  description,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="text-base font-semibold text-foreground">
        {title}
      </h3>
      {description === undefined ? null : <p className="pb-1 text-xs text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

/**
 * Settings > Keyboard: the phone keys bar's own keys, their order, the packs that add a second group of keys, and the
 * keys the person defines. Every change is stored on this device as it is made; the preview above follows it at once.
 */
export function KeyboardSection() {
  const settings = useKeyBarSettings();
  const error = useKeyBarError();
  const host = currentPlatform();
  const readOnly = error !== null;
  return (
    <div className="flex flex-col gap-5">
      {error === null ? null : (
        <Notice tone="error" title="Key settings could not be read from this browser's storage">
          Changes are not saved, so the stored keys stay as they are. Reload the page to try again.{" "}
          {asSentence(error.message)}
        </Notice>
      )}
      <KeyBarPreview settings={settings} host={host} readOnly={readOnly} />
      <Group
        id="keyboard-in-bar"
        title="In the bar"
        description="Drag a row or use its arrows to change the order. The X takes a key out; nothing here is lost."
      >
        <KeyOrderList settings={settings} host={host} readOnly={readOnly} />
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 self-start"
          disabled={readOnly}
          onClick={() => void keyBarStore.update((current) => resetKeys(current))}
        >
          <RotateCcw />
          Reset to the default keys
        </Button>
      </Group>
      <Group id="keyboard-more" title="Not in the bar" description="Put a key back where the list places it.">
        <KeyRestoreList settings={settings} host={host} readOnly={readOnly} />
      </Group>
      <Group
        id="keyboard-packs"
        title="Shortcut packs"
        description="A pack adds its keys to the bar as a tab. Long-press Ctrl in the terminal to switch packs."
      >
        <PackList settings={settings} readOnly={readOnly} />
      </Group>
      <Group id="keyboard-favorites" title="Your keys" description="Add a key of your own to the Favorites pack.">
        <FavoriteKeys settings={settings} readOnly={readOnly} />
      </Group>
    </div>
  );
}
