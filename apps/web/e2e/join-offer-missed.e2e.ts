import { FrameKind, MESH_OFFER_DOC, encodeFrame, isJsonObject } from "@doriface/protocol";
import { coreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

for (const width of [1440, 390]) {
  test(`the join dialog recovers a missed offer update at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const socket = await routeHcSocket(page);
    await page.goto(width === 390 ? "/settings" : "/");
    if (width === 390) await page.getByRole("tab", { name: "Machines" }).click();
    await page.getByRole("button", { name: width === 390 ? "Add a machine" : "Add machine" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    await expect(dialog.getByLabel("Join command")).toBeVisible({ timeout: 30_000 });

    // Keep the actual doc event off the page. A missed notification is the only signal it receives for the join.
    socket.holdFromHost('"type":"doc"');
    const doc = coreDoc(MESH_OFFER_DOC);
    if (!isJsonObject(doc) || !isJsonObject(doc["value"])) throw new Error("no offer document");
    setCoreDoc(MESH_OFFER_DOC, {
      request: doc["value"]["request"],
      joined: { name: "joiner", hostId: "joined-host" },
    });

    // Every subscribe reply identifies its channel and initial snapshot. Deliver recovery on those channels only.
    const channels = new Set<number>();
    for (const frame of socket.received()) {
      const payload = frame.slice(9).trim();
      if (!payload.startsWith("{")) continue;
      const reply: unknown = JSON.parse(payload);
      const result = isJsonObject(reply) ? reply["result"] : undefined;
      if (isJsonObject(result) && typeof result["channel"] === "number" && "seq" in result)
        channels.add(result["channel"]);
    }
    expect(channels.size).toBeGreaterThan(0);
    for (const channel of channels) {
      socket.sendFromHost(
        Buffer.from(
          encodeFrame(
            channel,
            FrameKind.Data,
            new TextEncoder().encode(
              `${JSON.stringify({ jsonrpc: "2.0", method: "missed", params: { seq: 1_000_000, terminals: [] } })}\n`,
            ),
          ),
        ),
      );
    }
    await expect(dialog.getByText("joiner joined this host's mesh")).toBeVisible();
  });
}
