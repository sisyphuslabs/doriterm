// The mesh stream's lines live in @doriface/mesh/join since the browser joiner shares them (#1386); the host's own
// modules keep this path.
export {
  INVITER_EXPECTS,
  JOINER_EXPECTS,
  type LineLink,
  type LineType,
  MAX_LINE_BYTES,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_LINES,
  type MeshLine,
  MeshLines,
  recordLines,
  SYNC_EXPECTS,
} from "@doriface/mesh/join";
