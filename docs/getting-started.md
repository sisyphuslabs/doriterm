# Getting started

From nothing to an agent on your computer that you can reach from your phone. Everything here is public: a release
download, the hosted relay at `relay-doriface.omo.dev` and the hosted web app at https://app.doriterm.com. No account,
no token and no server of your own.

Each release runs the steps in sections 2 and 3 against its own Linux AppImage before it is published: the release smoke
starts the app, opens **Pair a device**, opens what the QR code holds in a fresh browser, pairs through the hosted relay
and types into a terminal on that computer (`apps/desktop/e2e/hosted-relay-pair.e2e.ts`). The `From zero` workflow runs
the same check after every merge to `dev` and once a day.

## 1. Install the desktop app

Download the build for your computer from the [latest release](https://github.com/sisyphuslabs/doriterm/releases/latest)
and check it against `SHA256SUMS.txt` from the same release.

| Computer              | File                                            |
| --------------------- | ----------------------------------------------- |
| macOS (Apple silicon) | `Doriterm-<version>-arm64.dmg`                  |
| macOS (Intel)         | `Doriterm-<version>-x64.dmg`                    |
| Windows (x64, arm64)  | the setup `.exe` for your architecture          |
| Linux (x64, arm64)    | the `.AppImage` or `.deb` for your architecture |

macOS: from v0.1.1 the app is signed and notarized, so it opens like any other app. Windows: the installer is not code
signed yet, so SmartScreen warns about an unknown publisher; choose **More info**, then **Run anyway**.

## 2. Use this computer

Open the app and choose **Use this computer**. The app starts its host and herdr-core (`hc`) on this computer; when
herdr-core is missing or too old, it offers **Install herdr-core**, for your user only. The workspace opens with **New tab**.

## 3. Pair your phone

1. In the app, open **Settings > Connections** and choose **Pair a device**. It shows a QR code, an 8-character code,
   this computer's key and how long the offer lasts.
2. Scan the QR code with the phone's camera. It opens the pair page of the hosted web app, https://app.doriterm.com.
   No camera at hand: open https://app.doriterm.com/pair on the phone and type the code.
3. The phone shows the host's key. Compare its groups with the ones under **This computer's key** in the app and choose
   **They match**. The app's dialog then says **Paired with** your phone.

Traffic between the phone and this computer is end-to-end encrypted; the relay only carries ciphertext. On the phone,
add the page to the home screen to use it as an app.

## 4. Open an agent

On the phone, choose **Open terminals**, then **New tab**. The terminal runs on your computer: start your agent in it
the way you would at the computer, for example `claude` or `codex`. Agents running on that computer are listed under
**Agents**, and a prompt that waits for you shows as a card you can answer from the phone.

## When something does not work

- **Pair a device** says the host did not answer: choose **Try again**. The app restarts its host when it stops.
- The phone says the offer expired: an offer lasts 10 minutes. Choose **Try again** in the app's dialog (or **New code**
  while the old one is still showing) and scan the new QR code.
- Another computer, rather than a phone: open the `doriface://pair#…` link from **Pairing link** on that computer, where
  the desktop app takes it.

Building from source instead: see [CONTRIBUTING.md, "From zero"](../CONTRIBUTING.md#from-zero).
