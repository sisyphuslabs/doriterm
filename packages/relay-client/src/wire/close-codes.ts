/** WebSocket close codes on relay sockets: the contract's 44xx codes plus the standard ones the relay uses. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  MessageTooBig: 1009,
  InternalError: 1011,
  CryptoFailure: 4400,
  UnknownDevice: 4401,
  RelayProtocolError: 4402,
  RelayAuthFailed: 4403,
  HostOffline: 4404,
  IdleTimeout: 4408,
  /** The relay accepted a newer authenticated uplink for the same hostId. */
  UplinkReplaced: 4409,
  /** A pairing session named a slot that is not registered to this host (expired or never opened). */
  PairSlotUnknown: 4410,
  /**
   * The host refused a typed-code mesh join on its own terms: the invite was used, expired or replaced, none is
   * pending, or the plan refuses it. A join on a device pairing offer is 4401 instead (contract v1.10.3).
   */
  MeshCodeRefused: 4411,
  /** The relay refused an upgrade's pass proof (contract v1.6); dial again without one. Never final. */
  PassRefused: 4412,
  RateLimited: 4429,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Codes an endpoint may pass to `WebSocket.close()`; anything else is reported as a normal close. */
export function sendableCloseCode(code: number): number {
  return code === CloseCode.Normal || (code >= 3000 && code <= 4999) ? code : CloseCode.Normal;
}
