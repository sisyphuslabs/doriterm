import { contextBridge, ipcRenderer } from "electron";
import {
  Channel,
  isDirectForward,
  isDirectForwardRefused,
  isHcInstallAnswer,
  isLocalHostEndpoint,
  isLocalHostStartFailed,
  isNoticeAnswer,
  isNoticeAuthorization,
  isPairedDevicesAnswer,
  isPairOfferAnswer,
  isRevokeDeviceAnswer,
  isUpdateReady,
  parsePlatform,
  VERSION_ARG,
  type DorifaceBridge,
} from "../shared/bridge.ts";

const version = process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "0.0.0";

const bridge: DorifaceBridge = {
  version,
  platform: parsePlatform(process.platform),
  async openExternal(url) {
    const opened: unknown = await ipcRenderer.invoke(Channel.openExternal, url);
    return opened === true;
  },
  async openLink(url) {
    const opened: unknown = await ipcRenderer.invoke(Channel.openLink, url);
    return opened === true;
  },
  async startLocalHost() {
    const answer: unknown = await ipcRenderer.invoke(Channel.startLocalHost);
    if (isLocalHostStartFailed(answer)) return { failure: answer.failure };
    if (!isLocalHostEndpoint(answer)) throw new Error("the main process returned no local host endpoint");
    return { url: answer.url, token: answer.token };
  },
  async pairOffer(request) {
    const answer: unknown = await ipcRenderer.invoke(Channel.pairOffer, request);
    if (!isPairOfferAnswer(answer)) throw new Error("the main process returned no pairing offer");
    return answer;
  },
  async pairedDevices() {
    const answer: unknown = await ipcRenderer.invoke(Channel.pairedDevices);
    if (!isPairedDevicesAnswer(answer)) throw new Error("the main process returned no paired device list");
    return answer;
  },
  async revokeDevice(id) {
    const answer: unknown = await ipcRenderer.invoke(Channel.revokeDevice, id);
    if (!isRevokeDeviceAnswer(answer)) throw new Error("the main process returned no revoke answer");
    return answer;
  },
  onNavigate(listener) {
    ipcRenderer.on(Channel.navigate, (_event, path: unknown) => {
      if (typeof path === "string") listener(path);
    });
  },
  async setWindowBackground(color) {
    const painted: unknown = await ipcRenderer.invoke(Channel.setWindowBackground, color);
    return painted === true;
  },
  async closeWindow() {
    await ipcRenderer.invoke(Channel.closeWindow);
  },
  onPairingLink(listener) {
    const take = async (): Promise<void> => {
      const fragment: unknown = await ipcRenderer.invoke(Channel.takePairingLink);
      if (typeof fragment === "string") listener(fragment);
    };
    ipcRenderer.on(Channel.pairingLinkWaiting, () => void take());
    void take();
  },
  onRunAction(listener) {
    ipcRenderer.on(Channel.runAction, (_event, action: unknown) => {
      if (typeof action === "string") listener(action);
    });
  },
  async setMenuKeys(keys) {
    const shown: unknown = await ipcRenderer.invoke(Channel.setMenuKeys, keys);
    return shown === true;
  },
  async chooseHc() {
    const chosen: unknown = await ipcRenderer.invoke(Channel.chooseHc);
    return typeof chosen === "string" ? chosen : null;
  },
  async installHc(onPhase) {
    const phase = (_event: unknown, name: unknown): void => {
      if (typeof name === "string") onPhase(name);
    };
    ipcRenderer.on(Channel.hcInstallPhase, phase);
    try {
      const answer: unknown = await ipcRenderer.invoke(Channel.installHc);
      if (!isHcInstallAnswer(answer)) throw new Error("the main process returned no install answer");
      return answer;
    } finally {
      ipcRenderer.removeListener(Channel.hcInstallPhase, phase);
    }
  },
  onUpdateReady(listener) {
    const take = async (): Promise<void> => {
      const staged: unknown = await ipcRenderer.invoke(Channel.takeUpdate);
      if (isUpdateReady(staged)) listener({ version: staged.version });
    };
    ipcRenderer.on(Channel.updateReady, () => void take());
    void take();
  },
  async installUpdate() {
    const installing: unknown = await ipcRenderer.invoke(Channel.installUpdate);
    return installing === true;
  },
  async noticesSupported() {
    const supported: unknown = await ipcRenderer.invoke(Channel.noticesSupported);
    return supported === true;
  },
  async noticePermission() {
    const authorization: unknown = await ipcRenderer.invoke(Channel.noticePermission);
    return isNoticeAuthorization(authorization) ? authorization : "unknown";
  },
  async showNotice(notice) {
    const answer: unknown = await ipcRenderer.invoke(Channel.showNotice, notice);
    return isNoticeAnswer(answer) ? answer : { accepted: false, reason: "the main process returned no answer" };
  },
  onNoticeClick(listener) {
    ipcRenderer.on(Channel.noticeClicked, (_event, terminal: unknown) => {
      if (terminal === null || typeof terminal === "string") listener(terminal);
    });
  },
  async setDirectTarget(directUrl) {
    const kept: unknown = await ipcRenderer.invoke(Channel.setDirectTarget, directUrl);
    return kept === true;
  },
  async forwardDirect() {
    const answer: unknown = await ipcRenderer.invoke(Channel.directForward);
    if (isDirectForward(answer)) return { url: answer.url };
    if (isDirectForwardRefused(answer)) return { refused: answer.refused };
    return { refused: "the shell returned no forward" };
  },
  async cancelDirectForward(url) {
    const cancelled: unknown = await ipcRenderer.invoke(Channel.cancelDirectForward, url);
    return cancelled === true;
  },
};

contextBridge.exposeInMainWorld("doriface", bridge);
