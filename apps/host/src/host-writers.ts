import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import type { MeshStatus } from "@doriface/protocol";
import type { e2eeDeps } from "./host-e2ee.ts";
import type { HostOptions } from "./host-types.ts";
import { type GitFactsPublisher, publishGitFacts } from "./git-facts.ts";
import { type HostInfoPublisher, publishHostInfo } from "./host-info.ts";
import { type Clock, monotonicClock } from "./mesh/clock.ts";
import { HC_STOP_GRACE_MS, type HcTarget } from "./mesh/hc-machines.ts";
import { type MeshOfferService, serveMeshOffers } from "./mesh/offer-doc.ts";
import { publishMeshStatusOnCore, type MeshStatusPublisher } from "./mesh/status-publisher.ts";
import { pairingArtifact } from "./pair-link.ts";
import { skillHooks } from "./skill/skill-host.ts";

type E2ee = ReturnType<typeof e2eeDeps>;

export interface WriterParts {
  readonly core: HcTarget;
  readonly options: HostOptions;
  readonly e2ee: E2ee | undefined;
  readonly meshStatus: (() => MeshStatus | undefined) | undefined;
  readonly refreshMeshLines: () => Promise<void>;
  readonly started: (name: string, stop: () => unknown, kill?: () => readonly string[]) => void;
}

export interface Writer {
  stop(): Promise<unknown>;
  kill(): readonly number[];
}

/**
 * Stops a writer, and kills its `hc connect` child if closing it has not ended it within the grace: a launch a busy
 * machine still holds when the host stops would otherwise start the core after the host is gone (#441).
 */
export async function stopWriter(
  writer: Writer | undefined,
  clock: Pick<Clock, "after"> = monotonicClock,
): Promise<void> {
  if (writer === undefined) return;
  const cancel = clock.after(HC_STOP_GRACE_MS, () => writer.kill());
  try {
    await writer.stop();
  } finally {
    cancel();
  }
}

const pids = (killed: readonly number[] | undefined): string[] => (killed ?? []).map((pid) => `hc connect pid ${pid}`);

/**
 * The host's writers on its own core: its facts (OS and agent skill), its git facts, its mesh status, and the service
 * that answers the offer, approval and agent skill requests clients write there. Every hc call starts its session's
 * core when none runs and a host that no one uses must not start one (#306), so they start only once the core is up:
 * with the first pipe a client opens, or with the mesh, whose reconciler keeps this core's machine list.
 */
export function coreWriters({ core, options, e2ee, meshStatus, refreshMeshLines, started }: WriterParts) {
  let info: HostInfoPublisher | undefined;
  let git: GitFactsPublisher | undefined;
  let meshDoc: MeshStatusPublisher | undefined;
  let offers: MeshOfferService | undefined;
  const skill = options.skill === undefined ? undefined : skillHooks(options.skill, () => info?.refresh(), options.log);
  void skill?.refreshOutdated();
  // A one-line Add a machine (#668): a client asks for a mesh offer through a core document, and the host answers it.
  const meshOffer = async (client: boolean) => {
    if (e2ee === undefined) throw new Error("this host keeps no state, so it cannot open a mesh offer");
    const offer = await e2ee.hostMesh.pair(!client);
    const keys = e2ee.identity;
    const link = pairingArtifact(
      {
        hostId: keys.hostId,
        noiseStaticPub: keys.noise.publicKey,
        signPub: keys.sign.publicKey,
        linkSecret: offer.linkSecret,
        relayUrl: options.relay?.url ?? DEFAULT_RELAY_URL,
        mesh: true,
      },
      undefined,
    ).url;
    return { link, expiresAt: offer.expiresAt };
  };
  started(
    "mesh offers",
    () => offers?.stop(),
    () => pids(offers?.kill()),
  );
  started(
    "host info",
    () => info?.stop(),
    () => pids(info?.kill()),
  );
  started(
    "git facts",
    () => git?.stop(),
    () => pids(git?.kill()),
  );
  // A host in no mesh writes the document empty (a mesh it left), so this starts with the others.
  started(
    "mesh status",
    () => meshDoc?.stop(),
    () => pids(meshDoc?.kill()),
  );
  const start = (): void => {
    info ??= publishHostInfo(core, options.platform ?? process.platform, options.log, undefined, skill?.status);
    git ??= publishGitFacts(core, options.log);
    meshDoc ??=
      meshStatus === undefined || e2ee === undefined
        ? undefined
        : publishMeshStatusOnCore(
            core,
            meshStatus,
            e2ee.identity.hostId,
            options.log,
            undefined,
            undefined,
            refreshMeshLines,
          );
    if (e2ee === undefined) return;
    const pending = e2ee.hostMesh.pending;
    offers ??= serveMeshOffers(
      core,
      options.log,
      (listener) => pending.onAdmitted(listener),
      meshOffer,
      undefined,
      undefined,
      (nonce, approve, code) => pending.decide(nonce, approve, code),
      skill?.answer,
    );
  };
  return {
    start,
    /** Starts them when this host is in a mesh: its reconciler has its core up already. */
    startIfInMesh: (): void => {
      if (e2ee?.mesh.read() !== undefined) start();
    },
    started: (): boolean => info !== undefined,
    skillChanged: skill?.changed,
    hostInfoSettled: () => info?.settled ?? Promise.resolve(),
    gitFactsSettled: () => git?.settled() ?? Promise.resolve(),
    meshStatusSettled: () => meshDoc?.settled() ?? Promise.resolve(),
    stopMeshDoc: () => stopWriter(meshDoc),
    stopOthers: () => Promise.all([stopWriter(info), stopWriter(git), stopWriter(offers)]),
  };
}
