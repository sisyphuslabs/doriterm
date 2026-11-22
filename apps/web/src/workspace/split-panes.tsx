import type { HcConnection } from "@doriface/client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type Axis, type Node, nodeAt, pathTo, resizeAt } from "@doriface/protocol/layout";
import { dropPreview } from "../layout/drop-zone.ts";
import { arrange, type Rect } from "../layout/rects.ts";
import type { TerminalEnd } from "../terminal/terminal-end.ts";
import type { LayoutTab } from "./layout-model.ts";
import type { Session } from "./model.ts";
import type { PaneSends } from "./pane-sends.ts";
import { type PaneActions, PlacedPane } from "./pane-slot.tsx";
import { PaneDivider } from "./pane-divider.tsx";
import { linePosition } from "./line-position.ts";
import { usePaneDrag } from "./use-pane-drag.ts";
import type { Layout, PaneTarget } from "./use-layout.ts";

/** Space between panes, px: the gap shows the canvas, so panes read as separate cards. */
export const PANE_GAP = 8;

export const panelId = (tab: string): string => `tab-panel-${tab}`;

function useBoxSize(): [React.RefObject<HTMLDivElement | null>, Rect] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const { clientWidth: width, clientHeight: height } = element;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { x: 0, y: 0, width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export interface SplitPanesProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Session[];
  readonly layout: Layout;
  /** Each tab's title as the strip shows it, so its panel is named the same (an unnamed tab takes its pane's title). */
  readonly titles: ReadonlyMap<string, string>;
  readonly onEnd: (address: string, end: TerminalEnd) => void;
  readonly onSplit: (axis: Axis, target: PaneTarget) => void;
  readonly onClose: (address: string) => void;
  readonly onEnded: (address: string, pid: number | null) => void;
  readonly sends: PaneSends;
  /** Docked under the focused pane of the tab in view only. */
  readonly dock: ReactNode;
}

/** The axis of the row or column a pane sits in: a fresh pane grows out of its neighbour along it. */
function axisAround(root: Node, pane: string): "row" | "column" | null {
  const path = pathTo(root, pane);
  const parent = path === null ? null : nodeAt(root, path.slice(0, -1));
  const type = parent?.["type"];
  return type === "row" || type === "column" ? type : null;
}

/**
 * Every tab's tree, each pane placed by its rectangle so a split or a close never remounts a terminal: panes are keyed
 * by id and only move. Hidden tabs stay mounted so their streams and scrollback survive tab switches.
 */
/** A drag of one divider in progress: the tab shows it before it is written. */
interface Preview {
  readonly tab: string;
  readonly container: string;
  readonly index: number;
  readonly delta: number;
  /** Set once let go: the tab's tree as it was, so the drag stays on screen until the write replaces that tree. */
  readonly over?: string;
}

/** The drag to show: a dropped one only until the tab's tree is no longer the one it was dropped on. */
function shownPreview(preview: Preview | null, tabs: readonly LayoutTab[]): Preview | null {
  if (preview?.over === undefined) return preview;
  const root = tabs.find((tab) => tab.key === preview.tab)?.root;
  return root !== undefined && JSON.stringify(root) === preview.over ? preview : null;
}

const HIDDEN: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** One set of pane callbacks for the life of the panes, each calling the latest props: a new one would render every pane. */
function usePaneActions(props: SplitPanesProps): PaneActions {
  const latest = useRef(props);
  latest.current = props;
  const [actions] = useState<PaneActions>(() => ({
    focus: (tab, pane) => latest.current.layout.focusPane(tab, pane),
    split: (axis, tab, pane) => latest.current.onSplit(axis, { tab, pane }),
    zoom: (tab, pane) => {
      latest.current.layout.focusPane(tab, pane);
      latest.current.layout.toggleZoom();
    },
    close: (address) => latest.current.onClose(address),
    end: (address, end) => latest.current.onEnd(address, end),
    ended: (address, pid) => latest.current.onEnded(address, pid),
  }));
  return actions;
}

export function SplitPanes(props: SplitPanesProps) {
  const { connection, terminals, layout, titles, sends, dock } = props;
  const actions = usePaneActions(props);
  const [ref, box] = useBoxSize();
  const [held, setPreview] = useState<Preview | null>(null);
  const preview = shownPreview(held, layout.tabs);
  useEffect(() => {
    if (held !== null && preview === null) setPreview(null);
  }, [held, preview]);
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  // Each tab's panes as last laid out, in the box's coordinates: what a pane drag measures its drop zones against.
  const laidOut = useRef(new Map<string, ReadonlyMap<string, Rect>>());
  const { drag, grab } = usePaneDrag(
    ref,
    (tab) => laidOut.current.get(tab),
    (_tab, pane, target) => void layout.move(pane, target.pane, target.zone),
  );
  // A divider drag lays panes out on every move; like a window resize it plays no motion, its release included: the
  // dropped drag stays on screen until its write lands, and that render changes the frame, so it moves no pane either.
  const frame = `${box.width}x${box.height}${preview === null ? "" : `:${preview.delta}`}`;
  return (
    <div className="min-h-0 flex-1 p-2">
      <div ref={ref} className="relative h-full w-full">
        {layout.tabs.map((tab) => {
          const selected = tab.key === layout.active?.key;
          const zoomed = selected ? layout.zoomed : null;
          const dragged =
            preview?.tab === tab.key ? resizeAt(tab.root, preview.container, preview.index, preview.delta) : null;
          const root = dragged ?? tab.root;
          const { panes, dividers, containers } = arrange(root, box, PANE_GAP, zoomed);
          laidOut.current.set(tab.key, panes);
          // herdr-app drags panes only in a split tab that is not zoomed, and only where the layout takes edits.
          const movable =
            selected && zoomed === null && tab.panes.length > 1 && !tab.transient && tab.readOnly === null;
          const dropping = drag?.tab === tab.key ? drag.target : null;
          const dropOn = dropping === null ? undefined : panes.get(dropping.pane);
          return (
            <div
              key={tab.mount ?? tab.key}
              id={panelId(tab.key)}
              role="tabpanel"
              aria-label={titles.get(tab.key) ?? (tab.name === "" ? "Tab" : tab.name)}
              hidden={!selected}
              className="absolute inset-0"
            >
              {tab.panes.map((pane) => {
                const placed = panes.get(pane.id);
                const grow = pane.id === layout.fresh ? axisAround(tab.root, pane.id) : null;
                const bump = layout.bumped?.pane === pane.id ? layout.bumped : null;
                // A pane a zoom hides stays mounted, so its stream and scrollback are there when it comes back.
                return (
                  <PlacedPane
                    key={pane.mount ?? pane.id}
                    {...(placed ?? HIDDEN)}
                    frame={frame}
                    grow={grow}
                    bump={bump}
                    hidden={placed === undefined}
                    shown={selected && placed !== undefined}
                    connection={connection}
                    tab={tab.key}
                    pane={pane.id}
                    mod={pane.mod}
                    terminal={pane.address === null ? undefined : byAddress.get(pane.address)}
                    split={tab.panes.length > 1}
                    focused={selected && layout.focused?.id === pane.id}
                    claimed={layout.claimed === pane.id}
                    zoomed={zoomed === pane.id}
                    actions={actions}
                    sends={sends}
                    dock={selected && layout.focused?.id === pane.id ? dock : null}
                    onGrab={movable ? grab(tab.key, pane.id) : undefined}
                  />
                );
              })}
              {selected && !tab.transient && tab.readOnly === null
                ? dividers.map((divider) => (
                    <PaneDivider
                      key={`${divider.container}:${divider.index}`}
                      divider={divider}
                      container={containers.get(divider.container) ?? box}
                      position={linePosition(root, divider.container, divider.index)}
                      onPreview={(delta) =>
                        setPreview(
                          delta === null
                            ? null
                            : { tab: tab.key, container: divider.container, index: divider.index, delta },
                        )
                      }
                      onDrop={(delta) => {
                        const { container, index } = divider;
                        setPreview({ tab: tab.key, container, index, delta, over: JSON.stringify(tab.root) });
                        void layout.resize(container, index, delta).then((written) => {
                          if (!written) setPreview(null);
                          return written;
                        });
                      }}
                      onResize={(delta) => void layout.resize(divider.container, divider.index, delta)}
                    />
                  ))
                : null}
              {drag?.tab === tab.key ? <div aria-hidden className="absolute inset-0 z-10 cursor-grabbing" /> : null}
              {dropping !== null && dropOn !== undefined ? (
                <div
                  aria-hidden
                  data-pane-drop={dropping.zone}
                  className="pointer-events-none absolute z-20 rounded-lg border-2 border-ring bg-ring/15"
                  style={(({ x, y, width, height }) => ({ left: x, top: y, width, height }))(
                    dropPreview(dropOn, dropping.zone),
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
