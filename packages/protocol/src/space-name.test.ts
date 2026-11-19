import { describe, expect, test } from "bun:test";
import type { Terminal } from "./__generated__/hc-api.ts";
import { folderSpaceName, isSystemDirectory, programSpaceName, terminalSpaceName } from "./space-name.ts";

const terminal = (fields: Partial<Terminal>): Terminal => ({
  address: "t1",
  argv: ["cmd.exe"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "C:\\Windows\\System32",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

describe("system directories (#2658)", () => {
  test("the roots and the system's own directories are system ones, on Windows in any case and either separator", () => {
    const system = [
      "/",
      "/usr/bin",
      "/etc",
      "/System/Library/CoreServices",
      "/private/var",
      "C:\\",
      "C:\\Windows\\System32",
      "c:/windows/syswow64",
      "C:\\Program Files",
      "D:",
      "\\\\?\\C:\\Windows\\System32",
      "\\\\.\\C:\\Windows",
      "\\??\\C:\\Windows\\System32",
      "\\\\?\\UNC\\server\\share\\Windows\\System32",
      "\\\\server\\share",
      "/mnt/c/Windows/System32",
      "/cygdrive/c/Windows",
      "/c/Windows/System32",
      "/root",
      "/var/root",
      "/usr/libexec",
      "/opt/homebrew",
    ];
    expect(system.filter((dir) => !isSystemDirectory(dir))).toEqual([]);
  });

  test("a project, a home directory or a scratch directory is not one", () => {
    const own = [
      "/home/me/api",
      "/Users/me",
      "/tmp",
      "/etc/nginx",
      "C:\\Users\\me\\src\\web",
      "C:\\Program Files\\App",
      "\\\\?\\C:\\src\\web",
      "/mnt/c/Users/me/web",
      "/c/src/web",
      "/mnt/data",
      "/srv",
      "/srv/docs",
      "/w",
      "/w/web",
      "/mnt/d",
      "/mnt/d/photos",
      "/c/Users",
    ];
    expect(own.filter(isSystemDirectory)).toEqual([]);
  });
});

describe("a space's name", () => {
  test("is a folder's last segment on either separator, and none for a system directory", () => {
    expect(
      [
        "/home/me/api/",
        "C:\\Users\\me\\web",
        "C:\\Windows\\System32",
        "/",
        "",
        "\\\\?\\C:\\Windows\\System32",
        "/mnt/c/Windows/System32",
        "\\\\?\\C:\\src\\web",
        "/w",
        "/mnt/d",
      ].map(folderSpaceName),
    ).toEqual(["api", "web", undefined, undefined, undefined, undefined, undefined, "web", "w", "d"]);
  });

  test("names a shell as its users do and keeps another program's own name", () => {
    expect(
      [
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "cmd.exe",
        "-zsh",
        "/usr/bin/fish",
      ].map(programSpaceName),
    ).toEqual(["PowerShell", "PowerShell", "Command Prompt", "Zsh", "Fish"]);
    expect([programSpaceName("/usr/local/bin/htop"), programSpaceName(undefined)]).toEqual(["htop", "Space"]);
  });

  test("of a terminal is its label, else its directory's, else the program it started", () => {
    expect([
      terminalSpaceName(terminal({ labels: { space: "infra" } })),
      terminalSpaceName(terminal({ foreground: { argv: ["vim"], cwd: "C:\\src\\web", name: "vim", pid: 2 } })),
      terminalSpaceName(terminal({})),
    ]).toEqual(["infra", "web", "Command Prompt"]);
  });
});
