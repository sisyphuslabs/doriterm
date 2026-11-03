import { expect, test } from "bun:test";
import { hashOf } from "../src/records/codec.ts";
import { canonicalOrder } from "../src/view/canonical.ts";
import { Dag } from "../src/view/dag.ts";
import { recordsOf } from "../src/view/rec-of.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import { cardScenarios } from "./fixtures/scenarios-cards.ts";
import { signScenario } from "./fixtures/signed.ts";

const partition = cardScenarios.find((s) => s.id === "A13")?.records ?? [];
const signed = signScenario(withChainNumbers(partition)).records;

test("canonicalOrder of signed records is the order the view evaluates, whatever order they arrive in", () => {
  const records = recordsOf(signed) ?? [];
  const dag = new Dag(records);
  const want = dag.canonicalOrder(dag.all());
  for (const arrival of [signed, signed.toReversed(), [...signed.slice(7), ...signed.slice(0, 7)]]) {
    expect(canonicalOrder(arrival).map(hashOf)).toEqual([...want]);
  }
});

test("canonicalOrder ignores a prev outside the set and lists a record delivered twice once", () => {
  const [, admitB, admitN1] = signed;
  if (admitB === undefined || admitN1 === undefined) throw new Error("A13 fixture");
  expect(canonicalOrder([admitN1, admitB, admitN1]).map(hashOf)).toEqual([hashOf(admitB), hashOf(admitN1)]);
});
