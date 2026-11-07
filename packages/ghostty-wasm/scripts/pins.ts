export const GHOSTTY = {
  repository: "ghostty-org/ghostty",
  tag: "v1.4.0",
  commit: "83fb95624b0439ee660c2679b43b38c8b63769cd",
  archiveSha256: "7759929eadaddf602d6fd5ad6b3403d854b91b7083975cd984bb525bc8275187",
} as const;

/** The wterm release whose Zig export layer @wterm/ghostty 0.5.9 loads. */
export const WTERM = {
  repository: "vercel-labs/wterm",
  tag: "v0.5.9",
  commit: "f797b1e2dc30242b434f0944c1b5b396e0702da9",
  archiveSha256: "b84cd4b7424ca7cba6f6c386eb74ca65d427d8e1a1f2add4970b15fa028c9232",
  wrapperDir: "packages/@wterm/ghostty/zig",
} as const;

export const ZIG_VERSION = "0.17.0";
export const OPTIMIZE = "ReleaseSmall";

export type ZigHost = "aarch64-macos" | "x86_64-macos" | "aarch64-linux" | "x86_64-linux";

export const ZIG_SHA256: Readonly<Record<ZigHost, string>> = {
  "aarch64-macos": "b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a",
  "x86_64-macos": "4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6",
  "aarch64-linux": "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8",
  "x86_64-linux": "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026",
};

export function codeloadUrl(repository: string, commit: string): string {
  return `https://codeload.github.com/${repository}/tar.gz/${commit}`;
}

export function zigUrl(host: ZigHost): string {
  return `https://ziglang.org/download/${ZIG_VERSION}/zig-${host}-${ZIG_VERSION}.tar.xz`;
}
