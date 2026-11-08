/**
 * Evaluates the subset of GitHub Actions expressions this repository's workflows use (`${{ ... }}`: context paths,
 * string, number and boolean literals, == != ! && || and parentheses, format(), and the status functions), so a test
 * can ask what a concurrency group or an `if:` comes to for one event instead of pinning the expression's text.
 * Semantics follow GitHub's: && and || return an operand, and strings compare without regard to case.
 */
export type Value = string | number | boolean | null | readonly Value[] | { readonly [key: string]: Value };

export interface Run {
  /** The contexts by name: github, inputs, steps, ... */
  readonly contexts: Readonly<Record<string, Value>>;
  /** The job's status so far, for success(), failure(), cancelled() and always(). */
  readonly status?: "success" | "failure" | "cancelled";
}

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|&&|\|\||[!(),])|([A-Za-z_][\w.*-]*))/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (match === null) {
      if (source.slice(start).trim() === "") break;
      throw new Error(`cannot read the expression at: ${source.slice(start)}`);
    }
    tokens.push(match[0].trim());
  }
  return tokens;
}

const truthy = (value: Value): boolean => value !== false && value !== 0 && value !== "" && value !== null;

const equal = (left: Value, right: Value): boolean =>
  typeof left === "string" && typeof right === "string" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** One step of a property path; `*` takes that key of every element (`labels.*.name`). */
function property(value: Value, key: string): Value {
  if (Array.isArray(value)) return key === "*" ? value : value.map((item) => property(item, key));
  if (typeof value !== "object" || value === null || key === "*") return null;
  return (value as { readonly [key: string]: Value })[key] ?? null;
}

function lookup(path: string, run: Run): Value {
  const [name = "", ...keys] = path.split(".");
  return keys.reduce<Value>((value, key) => property(value, key), run.contexts[name] ?? null);
}

function call(name: string, args: Value[], run: Run): Value {
  const status = run.status ?? "success";
  if (name === "format") {
    const [template = "", ...rest] = args.map((arg) => String(arg));
    return template.replace(/\{(\d+)\}/g, (_, index: string) => rest[Number(index)] ?? "");
  }
  if (name === "contains") {
    const [haystack = null, needle = null] = args;
    return Array.isArray(haystack)
      ? haystack.some((item) => equal(item, needle))
      : String(haystack).toLowerCase().includes(String(needle).toLowerCase());
  }
  if (name === "success") return status === "success";
  if (name === "failure") return status === "failure";
  if (name === "cancelled") return status === "cancelled";
  if (name === "always") return true;
  throw new Error(`no function ${name}()`);
}

/** The value of `expression`, with or without its `${{ }}`, for `run`. */
export function evaluate(expression: string, run: Run): Value {
  const tokens = tokenize(expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"));
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at++];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expected ${expected ?? "a token"} in ${expression}`);
    }
    return token;
  };
  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^\d/.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (peek() === "(") {
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      return call(token, args, run);
    }
    return lookup(token, run);
  };
  const comparison = (): Value => {
    const left = primary();
    const operator = peek();
    if (operator !== "==" && operator !== "!=") return left;
    take();
    const same = equal(left, primary());
    return operator === "==" ? same : !same;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unread tokens in ${expression}: ${tokens.slice(at).join(" ")}`);
  return value;
}
