import { expect, test } from "bun:test";
import { generateHostIdentity, hostIdOf } from "@doriface/crypto";
import { MCP_DOMAIN, mcpHostname, mcpResource } from "./label.ts";

test("a host's MCP name is its hostId under mcp.doriterm.com: one DNS label, lowercase, fixed length", () => {
  const identities = Array.from({ length: 200 }, () => generateHostIdentity());
  for (const { hostId } of identities) {
    const label = mcpHostname(hostId).slice(0, -MCP_DOMAIN.length - 1);
    expect(label).toBe(hostId);
    expect(label).toMatch(/^[a-z2-7]{26}$/);
    expect(mcpHostname(hostId).length).toBeLessThanOrEqual(253);
  }
  expect(new Set(identities.map(({ hostId }) => mcpHostname(hostId))).size).toBe(identities.length);
});

test("the name follows the key: the same signing key gives the same name, a rotated key a new one", () => {
  const host = generateHostIdentity();
  expect(mcpHostname(hostIdOf(host.sign.publicKey))).toBe(mcpHostname(host.hostId));
  expect(mcpHostname(generateHostIdentity().hostId)).not.toBe(mcpHostname(host.hostId));
});

test("anything that is not a hostId is refused, so no chosen or sequential name can become a label", () => {
  for (const name of [
    "studio",
    "host-1",
    "XASKHRYCOVP63EFJLWVY4V3JCU",
    "a.b",
    "",
    "xaskhrycovp63efjlwvy4v3jc",
    "xaskhrycovp63efjlwvy4v3jc1",
  ]) {
    expect(() => mcpHostname(name)).toThrow("hostId");
  }
});

test("the resource a token must name is the host's /mcp endpoint", () => {
  const { hostId } = generateHostIdentity();
  expect(mcpResource(hostId)).toBe(`https://${hostId}.${MCP_DOMAIN}/mcp`);
});
