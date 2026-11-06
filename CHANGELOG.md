# Changelog

## Unreleased

### Paired devices

- Settings > Connections lists the devices paired with this computer and revokes one; revoking closes its session at once and refuses that key from then on, so a lost phone no longer needs a terminal on this computer. (#709)

### Joining a mesh from a browser

- A browser with no account and no pairing opens the web app, follows an invite link a member sent, checks the host's fingerprint and lands on the mesh's terminals; a revisit needs no new invite. (#709)
- A mesh invite (`&m=1`) is no longer read as a device invite: the web app says it adds a machine, with the command that does, instead of reporting a link that was already used. (#709)

### Answering agents from the card

- The card pinned over a waiting agent answers every prompt Claude Code and Codex draw, not only Allow or Deny: each of the agent's own rows with its key, its questions (one or several in a row, multi-select, a typed answer), and a plan to approve. It shows what the agent said above the question, the directory it works in, the diff or file it touches, and opens the files it names. Every answer is still checked against the live screen first. (#669)
- A notification for a waiting agent offers its prompt's own rows, a question's included, fetched over the encrypted push stream: the agent's No row answers from the notification, any other row opens the app and is sent once it is on screen, and a prompt with several steps, boxes or a typed answer opens the card. (#669)

### Web app and PWA

- The installed web app carries its own app id and language, ships a maskable icon at 192 as well as 512, and opens standalone from an iOS home screen with its own title and status bar. (#709)
- A resize no longer moves a terminal's view: a terminal following its output stays on its last line when the window is resized, a split divider is dragged or the phone keyboard opens, even while an agent redraws its whole transcript for the new width, and a terminal scrolled into its history keeps its line at the top. (#811)

### Native apps

- A push bridge for the coming iOS and Android apps: the host's encrypted notices reach them through APNs and FCM, and the bridge never holds a key that opens one. (#705)
- An Android app: the same web client in a native shell, with notifications that arrive with the app closed and Allow and Deny on a permission prompt, answered once the app is on screen. The status and navigation bars follow the theme. (#704, #705)

### Desktop local host and pairing by code

- The host the desktop app starts joins the relay, so a phone or another computer can pair with this computer by code or link and reach its terminals. (#596)
- Settings > Connections has **Pair a device**: it asks this computer's host for a fresh offer and shows its QR code, link, 8-character code, fingerprint and expiry, then the device that used it — no terminal and no CLI. (#614)
- The web app is hosted at https://doriface.omo.dev, and the pairing QR code (in **Pair a device** and from `doriface-host pair`) opens its pair page on a phone, with the host's key ready to check. The link for another computer stays `doriface://pair#…`. (#700)
- The hosted web app sends a Content Security Policy: a page there runs only the app's own scripts and the terminal's wasm, connects only to the relay, and cannot be framed. Every deploy's probe checks the live origin sends it. (#703)

### Machine mesh

- A machine you had already added over ssh or with a via is replaced by its mesh line under the same name, and mesh status and the Mesh panel say what kind of entry it replaced. Its open tabs and layout carry over. (#710)

## v0.1.2 - 2026-11-06

### Tabs and spaces

- Tabs belong to a space, as in herdr-app: the tab bar shows the selected space's tabs, each space remembers the tab it showed, and the tab order is the same on every device. A new tab opens right after the one you are on. (#466)
- Rename a space from its menu, the command palette or a double-click; the new name shows on every device. (#416)
- Closing a tab or pane ends its program, and asks first only when the program is still busy; a close that needs no question shows none. (#426, #534)
- A tab follows its machine through a rename. (#495)
- A tab moved while its machine is being renamed stays visible: its layout follows the machine to the new name. (#589)
- A double-click on the tab after the selected one renames it instead of closing it. (#573)

### Sidebar and titlebar

- One sidebar toggle, placed after the macOS window buttons, and a titlebar laid out like herdr-app's. (#445)
- Agents sit at the bottom of the sidebar with a split you can drag, and two spaces with the same name show as separate rows. (#421)
- A machine's header keeps its name ahead of its state, and its buttons have tap areas that don't overlap. (#504)
- The machine header is labelled with the machine's name and state. (#579)
- The desktop app waits for your saved tabs before showing "No terminal open", and a terminal that is still opening says so. (#489)
- Native notifications in the desktop app, using the same triggers and settings as web push. (#412)

### Fonts, Korean text and the terminal

- Terminal text matches Ghostty's metrics, and wide Hangul fits its cells. (#430)
- Korean wraps between words, and a row's icon lines up with its first line. (#487)
- Copied text drops trailing spaces and blank rows, as Ghostty does; Ctrl+Shift+V and Shift+Insert paste; a double- or triple-click selection keeps the keyboard in the terminal. (#528, #532, #530)
- The Ghostty `theme` key accepts any theme in Appearance, by name or id. (#533)
- The import dialogs' line numbers are readable in both themes. (#484)
- On the phone, a long terminal title gets a second line instead of being cut. (#485)

### Connection and offline wording

- Offline, the status bar says the app reconnects when the network is back and offers Try again, and no machine shows as connected while you are offline. (#493)
- Settings explains in words why a host can't be reached; the raw error code is under Details. (#486)
- Coming back from Settings keeps your sessions and reconnects at once. (#456)
- Reload to update now always lands on the new version. (#539)
- There is no Direct address field any more; the relay is shown without an edit field. (#460)
- A machine list that cannot be read says so plainly, with the error under Details, instead of a raw error beside the connection notice. (#552)

### Desktop local host and pairing by code

- If the desktop app's local host has stopped, it is started again before reconnecting. (#525)
- Pairing by code works in the desktop app's release build. (#544)
- The token for this computer's host is only ever sent to this computer. (#463)

### Windows

- The app's state lock no longer trips over a state folder that Windows is still deleting. (#524)
- On Windows arm64, the state lock reads why a file could not be opened from Windows' own status, so a worker no longer dies on a failed open that reports no error. (#578)
- Both Windows installers, x64 and arm64, are now installed and started on a clean machine before each release is published. (#451)
- Windows builds are still not code signed, so SmartScreen warns on first run; see Code signing below.

### Reliability

- A terminal on a link that just dropped no longer throws an error into the page. (#465)
- A stopped host never restarts its terminal core behind your back. (#455)
- Relayed sessions are faster on bulk output and handle split frames correctly. (#517)
- A terminal that floods output no longer slows the app: output is drawn at most once a frame, flow control holds the program back until it is drawn, and hidden panes draw nothing. (#586)
- Ending a terminal reaches the host even when the page closes right after you confirm. (#582)
- A host in a large mesh acknowledges its own changes without re-reading the whole mesh each time. (#577)
- The desktop app's content security policy stays strict while scroll areas hide their native scrollbars. (#520)
- The app starts and keeps working when the browser refuses storage, as private windows and blocked site data do. (#550, #554)
- On phones, the app, its header, its status bar and its sheets keep clear of the notch, the rounded corners and the home indicator on every side. (#561, #565)
- An older browser gets an Update your browser screen instead of a page that does not work. (#563)
- Many test and CI fixes, so problems are caught before a release instead of after. (#444, #450, #453, #457, #467, #471, #490, #491, #492, #494, #498, #501, #505, #506, #507, #508, #511, #513, #514, #519, #523, #531, #536, #538, #541, #543, #546, #549, #558, #564, #569, #571, #574, #575, #585, #588)

## v0.1.1 - 2026-11-05

### Signed macOS app and Windows

- The macOS app is signed with a Developer ID certificate and notarized by Apple, and the dmg is stapled, so it opens without a Gatekeeper warning. (#382)
- On Windows, the host keeps its keys and private state readable only by you, and it refuses a herdr-core older than 0.1.17. (#433)
- The app installs herdr-core for you when it is missing or too old: a verified download, installed for your user only. (#417)
- Release builds connect only to the production relay. (#411)

### Panes, spaces and the terminal

- Drag a pane by its header to move it within its tab, as in herdr-app, or swap panes from the keyboard. (#442)
- A space row shows its branch, ahead or behind, uncommitted changes or a detached head, only when one of them is unusual. (#380)
- Cmd/Ctrl + and - and 0 size the terminal text instead of zooming the whole window. (#413)
- A selection covers whole cells and stays contiguous across wide characters. (#437)
- Keys you type while a terminal opens on its own are kept, and a terminal that answers after you moved on no longer takes the keyboard. (#414, #375)
- A terminal started again with Try again gets its focus back. (#386)
- The sidebar list and the tab strip show no classic scrollbars while their content fits. (#374)
- The browser's theme colour follows the theme you are looking at. (#371)

### Updates and Settings

- An update that is ready lights a dot on Settings, and Settings restarts or reloads into it; the phone's Settings gear shows the dot too. (#394, #425)
- Voice input says what dictation does and where its microphone is, and why it cannot listen when it cannot. (#398)

### Hosts and the mesh

- Stopping a host ends the handshakes in flight instead of waiting for them to time out. (#438)
- A link opened while its device is being revoked is closed. (#439)
- Re-pairing a host compares and saves it in one step, so two pairings at once cannot mix. (#396)
- Adding a machine reserves both of its relay connections together. (#373)
- Many test fixes, so problems are caught before a release instead of after. (#363, #370, #377, #378, #399, #400, #405, #407, #423, #428, #431, #432, #434, #436, #443)

## v0.1.0 - 2026-11-05

The first release: an end-to-end encrypted web, PWA and desktop face for herdr-core.

- The desktop app for macOS, Windows and Linux starts a host and herdr-core on your computer and shows its terminals; the same client runs in a browser and installs as a PWA.
- Every herdr-core method works unchanged: the host passes herdr-core's own protocol straight through.
- Terminals render with libghostty, built from Ghostty v1.4.0.
- Traffic between your devices and a host is end-to-end encrypted with Noise and carried by a public relay that only ever sees ciphertext.
- Pair a device with an 8-character code or a one-tap link, and add other machines through the relay with `hc machine add --via 'doriface-host connect <host>'`, with no ssh and no open port.
- Everything up to and including #367.
