import { expect, test } from "bun:test";
import { evaluate, type Value } from "./gh-expression.ts";

/** What `expression` comes to with `contexts` under GitHub's expression rules. */
const value = (expression: string, contexts: Record<string, Value> = {}): Value => evaluate(expression, { contexts });

// #1145: GitHub compares values of different types as numbers, so `'7' == 7` is true in a workflow and must be here.
test("== and != coerce different types to numbers, as the docs' loose-equality table says", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["1 == '1'", true],
    ["1 == '1.0'", true],
    ["1 == true", true],
    ["0 == false", true],
    ["0 == null", true],
    ["0 == ''", true],
    ["'0' == false", true],
    ["'1' == true", true],
    ["1 == 'one'", false],
    ["1 != 'one'", true],
    ["0 == 'one'", false],
    ["0 != 'one'", true],
    ["0 == null && 1 != null", true],
  ];
  for (const [expression, expected] of cases) expect([expression, value(expression)]).toEqual([expression, expected]);
});

test("values of the same type skip numeric coercion, and strings ignore case", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["'Deploy-Web' == 'deploy-web'", true],
    ["'Deploy-Web' != 'deploy-web'", false],
    ["'1' == '1.0'", false],
    ["'01' == '1'", false],
    ["1 == 1.0", true],
    ["true == true", true],
    ["true == false", false],
    ["null == null", true],
  ];
  for (const [expression, expected] of cases) expect([expression, value(expression)]).toEqual([expression, expected]);
});

test("arrays and objects are equal only when they are the same instance", () => {
  const list: Value = [1, 2];
  const item: Value = { id: 1 };
  const contexts: Record<string, Value> = { list, twin: [1, 2], item, clone: { id: 1 } };
  const cases: readonly (readonly [string, boolean])[] = [
    ["list == list", true],
    ["list == twin", false],
    ["list != twin", true],
    ["item == item", true],
    ["item == clone", false],
    ["list == 0", false],
  ];
  for (const [expression, expected] of cases)
    expect([expression, value(expression, contexts)]).toEqual([expression, expected]);
});

// #1145: `*` is GitHub's object filter. A plain key on an array is not a filter and answers null, while the key after
// `*` maps over the selected items.
test("a key on an array maps only after *, where it selects the item key", () => {
  const contexts: Record<string, Value> = {
    labels: [{ name: "bug" }, { name: "ui" }],
    pull_request: { labels: [{ name: "bug" }, { name: "ui" }] },
  };
  expect(value("labels.*.name", contexts)).toEqual(["bug", "ui"]);
  expect(value("pull_request.labels.*.name", contexts)).toEqual(["bug", "ui"]);
  expect(value("labels.name", contexts)).toBe(null);
  expect(value("pull_request.labels.name", contexts)).toBe(null);
});

test("contains() searches the array that * selects", () => {
  const contexts: Record<string, Value> = { labels: [{ name: "bug" }, { name: "ui" }] };
  expect(value("contains(labels.*.name, 'BUG')", contexts)).toBe(true);
  expect(value("contains(labels.*.name, 'chore')", contexts)).toBe(false);
});

// #2126: a missing input is null, and null == false, so a workflow tells "not given" from false by its JSON text.
test("toJSON writes a scalar as JSON, so a null input and a false one compare apart", () => {
  expect(value("toJSON(inputs.x)", { inputs: { x: null } })).toBe("null");
  expect(value("toJSON(inputs.x)", { inputs: { x: false } })).toBe("false");
  expect(value("toJSON(inputs.x)", { inputs: {} })).toBe("null");
  expect(value("inputs.x == false", { inputs: { x: null } })).toBe(true);
  expect(value("toJSON(inputs.x) == 'false'", { inputs: { x: null } })).toBe(false);
});
