import { type DeviceStore, deviceIdOf, type PairedDevice } from "./state/devices.ts";

/** One paired device as a surface shows it: the short id a person can read out, its name, and when it paired. */
export interface DeviceView {
  readonly name: string;
  readonly id: string;
  readonly pairedAt: string;
}

export interface DeviceSurfaceOptions {
  readonly devices: DeviceStore;
  /**
   * Runs after a revoke is written: the revoked device's live sessions close (4401) and its push subscription is
   * dropped, exactly as `devices revoke` on the control socket does (`devices-changed`).
   */
  readonly changed: () => Promise<void>;
}

const view = (device: PairedDevice): DeviceView => ({
  name: device.name,
  id: deviceIdOf(device),
  pairedAt: device.pairedAt,
});

/** No device has the handle that was given; the routes answer 404 rather than 500. */
export class UnknownDeviceError extends Error {
  override readonly name = "UnknownDeviceError";
}

/** A short id two devices share; revoking one needs the full fingerprint, which only the terminal takes. */
export class AmbiguousDeviceError extends Error {
  override readonly name = "AmbiguousDeviceError";
}

/**
 * This computer's paired devices, for the app that runs the host: a member revokes a phone or a browser from the
 * computer it was paired to, without a terminal. The routes sit behind the same per-launch token as `/v1/hc` and never
 * on the LAN listener (contract v1.9.5's shape for `/v1/pair`), so only a process that already holds the token can
 * read the list or revoke.
 */
export class DeviceSurface {
  readonly #options: DeviceSurfaceOptions;

  constructor(options: DeviceSurfaceOptions) {
    this.#options = options;
  }

  list(): readonly DeviceView[] {
    return this.#options.devices.list().map(view);
  }

  /** Revokes one device by its short id; an id no device has is refused by name rather than revoking nothing quietly. */
  async revoke(id: string): Promise<readonly DeviceView[]> {
    const handle = id.replaceAll(" ", "").toUpperCase();
    // The routes take a short id only, so a collision is decided here: the store would otherwise throw, and that plain
    // error would reach the app as a 500 with no way to say what happened.
    const matches = this.#options.devices.list().filter((device) => deviceIdOf(device) === handle);
    if (matches.length > 1) {
      throw new AmbiguousDeviceError(
        `${handle} matches ${matches.length} devices; revoke one from this computer's terminal by its full fingerprint`,
      );
    }
    const revoked = this.#options.devices.revoke(handle).map(view);
    if (revoked.length === 0) throw new UnknownDeviceError(`no paired device has the id ${JSON.stringify(id)}`);
    await this.#options.changed();
    return revoked;
  }
}
