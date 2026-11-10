/**
 * The channel operations release-channel.yml runs (#1969). Each moves the pointer only over the one it read, and
 * re-signs the host manifest for the version the channel then offers, since the Worker cannot sign.
 *   head                      prints the pointer
 *   promote <version> <n>     sets the rollout of the version the channel offers to n percent (0 pauses it)
 *   rollback <version>        points the channel back at `previous`, only while it still offers <version>
 *   yank <version>            marks the version yanked: no feed, manifest or /dl names it again; /v/ still serves it
 */
import { type Channel, yankedKey } from "../../apps/get/src/names.ts";
import { RELEASE_PUBLIC_KEYS, releasePublicKey } from "../../packages/crypto/src/release.ts";
import type { ObjectStore } from "./r2-store.ts";
import { hostManifest, readComplete, readCurrentPointer, writeHostManifest, writePointer } from "./release-records.ts";

export type Operation =
  | { readonly op: "head" }
  | { readonly op: "promote"; readonly version: string; readonly percent: number }
  | { readonly op: "rollback"; readonly version: string }
  | { readonly op: "yank"; readonly version: string };

export interface ChannelContext {
  readonly store: ObjectStore;
  readonly channel: Channel;
  readonly origin: string;
  readonly secretKey: Uint8Array;
  readonly now: string;
  /** The keys shipped builds trust; a manifest signed by any other is refused before anything is written. */
  readonly trustedKeys?: readonly string[];
}

async function resign(ctx: ChannelContext, version: string, rollout: number): Promise<void> {
  const record = await readComplete(ctx.store, version);
  await writeHostManifest(
    ctx.store,
    ctx.channel,
    hostManifest(ctx.origin, ctx.channel, record, rollout),
    ctx.secretKey,
  );
}

export async function runOperation(ctx: ChannelContext, operation: Operation): Promise<string> {
  if (operation.op !== "head" && !(ctx.trustedKeys ?? RELEASE_PUBLIC_KEYS).includes(releasePublicKey(ctx.secretKey))) {
    throw new Error(
      "the signing key is not one of RELEASE_PUBLIC_KEYS, so no shipped build would accept its manifests",
    );
  }
  const current = await readCurrentPointer(ctx.store, ctx.channel);
  const pointer = current.pointer;
  if (operation.op === "head") return JSON.stringify(pointer);
  if (pointer === null) throw new Error(`the ${ctx.channel} channel has no pointer yet`);
  const conflict = () => new Error(`channels/${ctx.channel}.json moved while this run held it; nothing changed`);

  if (operation.op === "yank") {
    const marked = await ctx.store.put(
      yankedKey(operation.version),
      new TextEncoder().encode(`${ctx.now}\n`),
      { create: true },
      "text/plain",
    );
    if (pointer.version === operation.version) {
      if (pointer.previous === undefined)
        throw new Error(`${operation.version} has no previous version to offer instead`);
      await resign(ctx, pointer.previous, 100);
    }
    return `${operation.version} ${marked ? "yanked" : "was already yanked"}`;
  }
  if (pointer.version !== operation.version) {
    throw new Error(`the ${ctx.channel} channel offers ${pointer.version}, not ${operation.version}; nothing changed`);
  }
  if (operation.op === "promote") {
    if (!Number.isInteger(operation.percent) || operation.percent < 0 || operation.percent > 100) {
      throw new Error(`the rollout must be a whole percentage, not ${operation.percent}`);
    }
    if (!(await writePointer(ctx.store, ctx.channel, current, { ...pointer, rollout: operation.percent })))
      throw conflict();
    await resign(ctx, pointer.version, operation.percent);
    return `${ctx.channel} offers ${pointer.version} to ${operation.percent}%`;
  }
  const previous = pointer.previous;
  if (previous === undefined) throw new Error(`${pointer.version} has no previous version to roll back to`);
  const record = await readComplete(ctx.store, previous);
  const next = {
    version: previous,
    rollout: 100,
    publishedAt: ctx.now,
    ...(record.minimum === undefined ? {} : { minimum: record.minimum }),
  };
  if (!(await writePointer(ctx.store, ctx.channel, current, next))) throw conflict();
  await resign(ctx, previous, 100);
  return `${ctx.channel} rolled back from ${pointer.version} to ${previous}`;
}
