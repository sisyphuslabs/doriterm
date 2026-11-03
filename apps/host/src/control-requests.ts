import { isRecord } from "./state/files.ts";

/** One request line on `host.sock` (section 10.1 lists the mesh operations). */
export type ControlRequest =
  | { readonly op: "pair" }
  | { readonly op: "devices-changed" }
  | { readonly op: "mesh-changed" }
  | { readonly op: "mesh-status" }
  | { readonly op: "mesh-pair"; readonly auto: boolean }
  | { readonly op: "mesh-pending" }
  | { readonly op: "mesh-approve"; readonly nonce: string; readonly approve: boolean }
  | {
      readonly op: "mesh-join";
      readonly target: string;
      readonly fingerprint: string | undefined;
      readonly name: string | undefined;
      readonly relay: string | undefined;
      readonly yes: boolean;
    };

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || typeof value === "string") return value;
  throw new Error("malformed control request");
};

function field<T>(value: unknown, check: (item: unknown) => item is T): T {
  if (check(value)) return value;
  throw new Error("malformed control request");
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

export function parseRequest(line: string): ControlRequest {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("unknown control request");
  const get = (key: string): unknown => value[key];
  const op = value["op"];
  switch (op) {
    case "pair":
    case "devices-changed":
    case "mesh-changed":
    case "mesh-pending":
    case "mesh-status":
      return { op };
    case "mesh-pair":
      return { op: "mesh-pair", auto: get("auto") === true };
    case "mesh-approve":
      return { op: "mesh-approve", nonce: field(get("nonce"), isString), approve: field(get("approve"), isBoolean) };
    case "mesh-join":
      return {
        op: "mesh-join",
        target: field(get("target"), isString),
        fingerprint: optionalString(get("fingerprint")),
        name: optionalString(get("name")),
        relay: optionalString(get("relay")),
        yes: get("yes") === true,
      };
    default:
      throw new Error("unknown control request");
  }
}
