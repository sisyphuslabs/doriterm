import { expect, test } from "bun:test";
import { serveMeshOffers } from "./offer-doc.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { client, field, noJoins } from "../testing/offer-doc-client.ts";

test("a browser offer request reaches the opener as an invite that must ask", async () => {
  const session = createHcSession("dh-client-offer");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const requested: boolean[] = [];
  const service = serveMeshOffers(
    target,
    () => {},
    noJoins,
    async (browser) => {
      requested.push(browser);
      return { link: "doriface://pair#h=x&m=1", expiresAt: Date.now() + 60_000 };
    },
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("browser", true);
    await app.until((value) => typeof field(value, "link") === "string");
    expect(requested).toEqual([true]);
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 5000);
