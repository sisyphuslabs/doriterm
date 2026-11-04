// The E-BACKDATE shapes (design section 3.6 and the PR 9 row of section 11), record for record and edge for edge as
// the design's model states them: the same ids, signers, subjects and `prev` links, cross-signer links included.
// Pure data, imported by the e2e (which writes the honest part with real commands and signs the attack) and by the
// design-model replay (which checks these exact graphs against the model and its mutations).

export type StepType = "found" | "admit" | "revoke" | "name" | "ack";

/** One record. Keys are the model's (A, B, G, X, Z0, ...); `prev` names other steps by id. */
export interface Step {
  readonly id: string;
  readonly type: StepType;
  readonly by: string;
  readonly prev: readonly string[];
  /** admit: the key admitted. name: the key renamed. */
  readonly subject?: string;
  /** revoke: the keys revoked. */
  readonly subjects?: readonly string[];
  /** name: the new mesh name. */
  readonly name?: string;
}

/** How the revoked key's records reach the honest hosts. */
export type Channel =
  /** Through another honest member's sync session (the injection the PR 9 row describes). */
  | "member"
  /**
   * N = 2 leaves no other member, so the revoked host carries its own records: it is offline while it is revoked,
   * holds the backdated records when it comes back, and answers the revoker's push to it with them (section 5.3).
   */
  | "revoked";

export interface BackdateShape {
  readonly id: string;
  /** Model key -> harness host name. Minted keys have no host. */
  readonly hosts: Readonly<Record<string, string>>;
  /** What the operators' commands and the hosts' automatic acks write, in order. */
  readonly honest: readonly Step[];
  /** The backdated records, in causal order. `FORK` in `prev` is the honest record `fork` names. */
  readonly attack: readonly Step[];
  /** The key whose stolen secret signs the attack. */
  readonly revoked: string;
  /**
   * The record `FORK` stands for: the revoked key's last own record (design section 3.7's L), which the attack must
   * continue from. A joiner acks its own admission (section 5.5), so that is its ack unless it wrote later.
   */
  readonly fork: string;
  readonly minted: readonly string[];
  /** Model keys the honest hosts judge with; each must end with `members` as its view. */
  readonly judges: readonly string[];
  /** The view R3 gives (for a residual, the fail-closed view the design asserts, not the honest one). */
  readonly members: readonly string[];
  /** Names the view must carry. */
  readonly names?: Readonly<Record<string, string>>;
  /** The fail-closed outcome: status shows `removed_undecidable` on every judge. */
  readonly failClosed: boolean;
  /** The revoke-time witness pool of the honest revoke is empty (section 6.1): the command needs `--yes`. */
  readonly emptyPool: boolean;
  readonly channel: Channel;
  /** Stop the revoked key's host before this honest step, so it never acks it or merges it. */
  readonly offlineBefore?: string;
  /**
   * The attack can reach no judge: the shape revokes each side from the other's view, and section 9.2 refuses a
   * revoked member's key on the mesh stream, so no session between them can exist. The judges keep their honest view.
   */
  readonly unreachable?: true;
}

export const FORK = "@fork";

const found = (id: string, by: string): Step => ({ id, type: "found", by, prev: [] });
const admit = (id: string, by: string, subject: string, prev: readonly string[]): Step => ({
  id,
  type: "admit",
  by,
  subject,
  prev,
});
const revoke = (id: string, by: string, subjects: readonly string[], prev: readonly string[]): Step => ({
  id,
  type: "revoke",
  by,
  subjects,
  prev,
});
const name = (id: string, by: string, subject: string, prev: readonly string[], to: string): Step => ({
  id,
  type: "name",
  by,
  subject,
  prev,
  name: to,
});
const ack = (id: string, by: string, prev: readonly string[]): Step => ({ id, type: "ack", by, prev });

/** A founds; A admits G, C; C admits B, who acks its admission; G acks. G revokes B; A and C ack. */
const honest3: readonly Step[] = [
  found("F", "A"),
  admit("aG", "A", "G", ["F"]),
  admit("aC", "A", "C", ["aG"]),
  admit("aB", "C", "B", ["aC"]),
  ack("kB", "B", ["aB"]),
  ack("kG", "G", ["aB"]),
  revoke("vB_byG", "G", ["B"], ["kG", "kB"]),
  ack("kA", "A", ["vB_byG"]),
  ack("kC", "C", ["vB_byG"]),
];
const HOSTS3 = { A: "a", G: "b", C: "c", B: "d" };

const R2: BackdateShape = {
  id: "R2",
  hosts: { A: "a", B: "b", X: "c" },
  honest: [
    found("F", "A"),
    admit("aB", "A", "B", ["F"]),
    admit("aX", "A", "X", ["aB"]),
    ack("kX", "X", ["aX"]),
    revoke("vX_byB", "B", ["X"], ["kX"]),
    name("nB_byA", "A", "B", ["vX_byB"], "b-2"),
  ],
  attack: [
    revoke("vB_byX", "X", ["B"], [FORK]),
    revoke("vA_byX", "X", ["A"], [FORK]),
    admit("aZ_byX", "X", "Z", [FORK]),
  ],
  revoked: "X",
  fork: "kX",
  minted: ["Z"],
  judges: ["A", "B"],
  members: ["A", "B"],
  names: { B: "b-2" },
  failClosed: false,
  emptyPool: false,
  channel: "member",
};

const P1: BackdateShape = {
  id: "P1",
  hosts: { A: "a", B: "b" },
  honest: [found("F", "A"), admit("aB", "A", "B", ["F"]), ack("kB", "B", ["aB"]), revoke("vB_byA", "A", ["B"], ["kB"])],
  attack: [admit("xZ_byB", "B", "Z", [FORK])],
  revoked: "B",
  fork: "kB",
  minted: ["Z"],
  judges: ["A"],
  members: ["A"],
  failClosed: false,
  emptyPool: true,
  channel: "revoked",
  offlineBefore: "vB_byA",
};

/**
 * The model's verdict on these records is fail-closed `{}` (section 3.6). On the hosts the records never form that
 * set: B's own `xA_byB` revokes A in B's view and `vB_byA` revokes B in A's, so each refuses the other (section 9.2)
 * and nothing of B's reaches A ("nothing of B's gets in"). A keeps its honest view, `{A}`.
 */
const P1b: BackdateShape = {
  ...P1,
  id: "P1b",
  attack: [...P1.attack, revoke("xA_byB", "B", ["A"], ["xZ_byB"])],
  members: [],
  failClosed: true,
  unreachable: true,
};

const P2: BackdateShape = {
  id: "P2",
  hosts: { A: "a", B: "b", C: "c", D: "d" },
  honest: [
    found("F", "A"),
    admit("aB", "A", "B", ["F"]),
    ack("kB", "B", ["aB"]),
    revoke("vB_byA", "A", ["B"], ["kB"]),
    admit("aC", "A", "C", ["vB_byA"]),
    ack("kC", "C", ["aC"]),
    admit("aD", "A", "D", ["kC"]),
    ack("kD", "D", ["aD"]),
  ],
  attack: [admit("xZ_byB", "B", "Z", [FORK]), revoke("xA_byB", "B", ["A"], ["xZ_byB"])],
  revoked: "B",
  fork: "kB",
  minted: ["Z"],
  judges: ["A", "C", "D"],
  members: [],
  failClosed: true,
  emptyPool: true,
  channel: "member",
  offlineBefore: "vB_byA",
};

const P3: BackdateShape = {
  id: "P3",
  hosts: HOSTS3,
  honest: honest3,
  attack: [
    admit("xZ0_byB", "B", "Z0", [FORK]),
    admit("xZ1_byZ0", "Z0", "Z1", ["xZ0_byB"]),
    revoke("xAC_byZ1", "Z1", ["A", "C"], ["xZ1_byZ0"]),
    revoke("xG_byB", "B", ["G"], ["xAC_byZ1"]),
    ack("xk_byZ1", "Z1", ["xG_byB"]),
  ],
  revoked: "B",
  fork: "kB",
  minted: ["Z0", "Z1"],
  judges: ["A", "G", "C"],
  members: ["A", "C", "G"],
  failClosed: false,
  emptyPool: false,
  channel: "member",
};

const P4: BackdateShape = {
  ...P3,
  id: "P4",
  attack: [
    admit("xZ0_byB", "B", "Z0", [FORK]),
    revoke("xAC_byB", "B", ["A", "C"], ["xZ0_byB"]),
    ack("xk_byB", "B", ["xAC_byB"]),
    revoke("xG_byZ0", "Z0", ["G"], ["xk_byB"]),
    revoke("xAGC_byB", "B", ["A", "G", "C"], ["xG_byZ0"]),
  ],
  minted: ["Z0"],
};

const P8: BackdateShape = {
  id: "P8",
  hosts: { G: "a", B: "b", A: "c" },
  honest: [
    found("F", "G"),
    admit("aB", "G", "B", ["F"]),
    ack("kB", "B", ["aB"]),
    admit("aA", "G", "A", ["kB"]),
    revoke("vB_byG", "G", ["B"], ["aA"]),
    ack("kA", "A", ["vB_byG"]),
  ],
  attack: [
    admit("xZ0_byB", "B", "Z0", [FORK]),
    revoke("xG_byB", "B", ["G"], ["xZ0_byB"]),
    revoke("xA_byZ0", "Z0", ["A"], ["xG_byB"]),
    ack("xk_byZ0", "Z0", ["xA_byZ0"]),
  ],
  revoked: "B",
  fork: "kB",
  minted: ["Z0"],
  judges: ["G", "A"],
  members: [],
  failClosed: true,
  emptyPool: true,
  channel: "member",
  offlineBefore: "aA",
};

/**
 * As P1b, the model's fail-closed `{}` is its verdict on a set the hosts never form: A's own records revoke D (its mint
 * Z1's `xD_byZ1`, testified by A) and `vA_byD` revokes A in D's view, so each refuses the other (section 9.2) and D
 * keeps its honest view, `{D}`.
 */
const P13: BackdateShape = {
  id: "P13",
  hosts: { A: "a", D: "b" },
  honest: [found("F", "A"), admit("aD", "A", "D", ["F"]), ack("kD", "D", ["aD"]), revoke("vA_byD", "D", ["A"], ["kD"])],
  attack: [
    admit("xZ1_byA", "A", "Z1", [FORK]),
    revoke("xD_byZ1", "Z1", ["D"], ["xZ1_byA"]),
    ack("xk_byA", "A", ["xD_byZ1"]),
  ],
  revoked: "A",
  fork: "aD",
  minted: ["Z1"],
  judges: ["D"],
  members: [],
  failClosed: true,
  emptyPool: true,
  channel: "revoked",
  offlineBefore: "vA_byD",
  unreachable: true,
};

export const BACKDATE_SHAPES: readonly BackdateShape[] = [R2, P1, P1b, P2, P3, P4, P8, P13];
