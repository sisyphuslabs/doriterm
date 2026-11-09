# Changelog

## Unreleased

## v0.1.16 - 2026-11-09

Highlights: coming back to the app, or reconnecting, no longer replays the old output line by line; the terminal shows
the screen as it is now, in one paint (#1620). Together with v0.1.15's reconnect fix, which keeps you where you had
scrolled (#1394), a terminal now comes back still and in place. Typing prediction also follows a cleared screen at
once (#1624), and Korean draws on Android tablets again. (#1619)

### Terminal

- Korean and other wide characters always draw: a device whose font measurements came back unusable used to size each
  of them to nothing, so an Android tablet showed blank cells where the Korean was. (#1619)
- Coming back to the app, or reconnecting, shows the terminal as it is now in one paint, instead of redrawing the
  output it missed line by line; the replay a reconnect needs is drawn once it has settled. (#1620)
- After clearing the screen, typing is predicted from the new cursor at once. (#1624)
- Switching tabs from the keyboard (Cmd+1-9, Cmd+Shift+[ and ], or a space shortcut) puts the keyboard in the terminal
  it shows, so you can type straight away without clicking it first. (#1752)

### Workspace

- A space row's branch and diff facts drop after the machine has not answered the facts read for a little over a
  minute, rather than staying on screen for as long as it reads connected. (#1661)

### Host install

- Unsafe Windows state-folder refusals now name the account or local group, identify the ancestor carrying an
  inherited permission grant, and explain how to remove the grant or move state with `DORIFACE_HOST_STATE_DIR`. (#1633)

### Native apps

- On iPhone, two requests to turn on notifications that arrive together both get the same registration; one no
  longer waits forever. (#1647)

### Website

- On the doriterm.com landing page, clicking to the Revoke scene eases cloud-box's load bar into place instead of
  jumping it, whether you arrive from another scene or catch the bar mid-tween. (#1671)

## v0.1.15 - 2026-11-09

Highlights: a terminal no longer jumps when it reconnects (#1394), and typing on a slow link shows at once, Korean
included (#1640). Pinned agent rows and spinners no longer change size or drift out of step (#1564, #1567), and Safari can
pair again. (#1639)

### Terminal

- A terminal no longer jumps when it reconnects: if you had scrolled up into its history, you stay at the same place
  while the screen is redrawn, and if you were following the newest output, you keep following it. Scrolling, a touch,
  a click or typing ends the hold at once. (#1394)
- A terminal whose program ends while its machine is offline shows "This session ended" once the machine is back,
  instead of closing its tab. (#1593)
- On a slow link, what you type is drawn at once and replaced by the host's own text when it arrives, underlined while
  the link is slow; Korean syllables are drawn too. Settings, Device, "Show typing before the host echoes it" chooses
  on slow links (the default), always, or off. (#1640)

### Workspace

- An agent waiting for input that Doriterm draws no card for (a plain "continue?", a menu, an agent it cannot read)
  shows Enter, Esc and the arrows over its terminal, on the desktop and the phone; each tap presses only that key, and
  the strip goes once the agent moves on. Claude Code and Codex keep their prompt card. (#1549)
- A pinned agent's pin no longer changes size when the pointer reaches its row: the resting pin and the Unpin action
  draw the same 14 px pin shape, filled on hover, and the row does not move. (#1564)
- Every working spinner turns in step with the others: the agents list, the space counts, tabs and buttons share one
  clock, so they stand at the same angle at the same moment, however late each appeared. (#1567)

### Machine mesh

- A Windows computer in a mesh names the other members with a command Windows can start, with no `sh`, instead of a
  POSIX shell line it could never run. Reaching them also needs a herdr-core that runs such commands on Windows.
  (#1581)

### Joining a mesh

- A browser that refuses to save its pairing key (Safari on some Macs) now keeps the key as raw bytes instead, so
  joining a mesh no longer fails with "The object can not be cloned." (#1639)

### Phone

- On a phone with a notch, the command palette now opens below it, so its search field and Cancel button are no longer
  hidden under the status bar. (#1511)
- With the soft keyboard down, a row of your keys sits under the terminal: Esc, an arrow or ^C answers a program in
  one tap without raising the keyboard. It is the same set Settings > Keyboard picks, and Read-only hides it. (#1554)
- With the keyboard up, the keys bar is two rows: the Type field across the width with Send at its end, then the keys,
  so Esc, ^C and the arrows show without a swipe. Enter joins the default keys, in the bar and in the row under the
  terminal. (#1554)
- Back from a terminal returns the Agents list, and a space's screen of tabs, to where you had scrolled them, instead
  of to the top. (#1557)
- A terminal at the bottom stays at the bottom when the soft keyboard is dismissed in a browser that resizes the page
  for it, instead of stopping a few pixels above its last line and no longer following the output. (#1573)
- A space's screen of tabs keeps each scroll under the space it shows, so Back to a space returns to that space's own
  place. (#1585)

### Desktop window

- A tab you have not named reads the title of the agent it runs instead of its number; a shell's tab keeps its number,
  and a name you give a tab still wins. (#1544)
- Settings > This device has Keep running in the background: closing the window leaves Doriterm and this computer's
  host running, so your phone stays connected. On a Mac it also leaves the Dock and the menu bar; open Doriterm again
  to bring the window back. (#1558)

### Settings

- Searching Settings lists the matching settings themselves, each with its section; picking one (or Enter on the
  first) opens that section scrolled to the row, with its control focused. "keybinds" now finds the keybinding import.
  (#1545)
- Successfully turning notifications on or off clears an earlier failure to move notifications to another host.
  (#1610)
- On macOS, Notifications reads the app's system authorization through the native addon instead of always saying the
  computer decides. A denied permission can now show the existing remedy and Check again controls. (#1628)

### Host install

- install.sh hands the mesh link to `mesh join` in a file only you can read, never on its command line where other
  local users can read it, and `DORIFACE_JOIN=<link>` joins like `--join` with the link off the installer's own
  command line. (#1625)
- The setup skill's `uninstall` removes the service even when the only herdr-core on the machine is older than the
  floor, since removing it never runs herdr-core. (#1629)

### Windows

- The host refuses a state folder that another account may rename, remove or re-permission even when that account's
  grant is listed after SYSTEM's or Administrators'. (#1636)

### Interface

- The explanation under an error notice, such as a refused pairing or unreadable storage, now uses a softened text
  colour that belongs to the red card instead of a flat gray. (#1524)

## v0.1.14 - 2026-11-09

### Workspace

- The command palette says where the highlighted agent lives: its machine, space and working directory, in one line
  under the results. (#1466)

### Machine mesh

- A browser or phone joins the mesh with its own identity and a code compared on both screens, keeps a verified list
  of machines, and reconnects to each machine independently. Membership survives dropped connections, and admitted
  clients can connect when the inviter is offline. Browser settings include membership, invitations, home-screen app
  handoff, and leaving the mesh. Each machine remembers a recent admitted client session across restarts; if saving
  that hint fails, the session remains usable. (#1446)

### Pairing from a phone

- An installed app with no pairing explains that its storage is separate from the browser tab it was installed
  from, so it needs to pair once as its own device. Opening or pasting an invite pairs it on that same screen; an
  already paired app does not show the notice. (#1411)

### Phone

- Opening a terminal on a phone leaves the soft keyboard down, and the keyboard button is what raises it: a new tab does
  not take the keyboard while it starts, and a terminal opened from the agents list does not take it as its view starts.
  A desktop, or a window driven by a mouse, still takes the keyboard as it opens. (#1376)
- The terminal header's ... opens one sheet for the session in view: where it lives, the next agent that needs you,
  Find in terminal, Rename and End. (#1469)
- Opening Settings on a phone moves focus into Settings, so a keyboard or switch user starts there instead of on the
  page behind. (#1505)
- The Type field and its Send button keep a clear gap between them, the same 0.5rem the phone leaves between its other
  buttons, so a thumb at the end of the field no longer lands on Send. (#1512)

### Interface

- A question such as Close space? no longer opens with Cancel focused: focus starts on the question itself, so Enter
  answers nothing and Tab reaches the buttons. A dialog that asks for text still opens in its field. (#1503)
- Disabled text buttons such as Reset all in Keybindings are easier to read, at least 4.5:1 in light and dark themes,
  and still look dimmer than when they can be used. (#1523)

## v0.1.13 - 2026-11-08

### New

- "Open the next agent that needs you" is a command in the palette while someone needs you, and an action you can bind
  in Settings > Keybindings. ([#1453](https://github.com/sisyphuslabs/doriterm/pull/1453))
- The command palette can narrow its agents to one state: when they are in more than one, counted segments under the
  search field offer All and the two most urgent states (Needs you first, then Working, Done or Idle).
  ([#1457](https://github.com/sisyphuslabs/doriterm/pull/1457))
- The desktop status bar says Connected while the session is healthy, and reads the place as one machine › space
  breadcrumb. ([#1468](https://github.com/sisyphuslabs/doriterm/pull/1468))

### Fixed

- Loading buttons keep their label for the first second, so quick actions no longer flash a spinner. With reduced
  motion, pending work shows a gentle opacity pulse instead of a spinning icon.
  ([#1452](https://github.com/sisyphuslabs/doriterm/pull/1452))
- A wait says what it waits for straight away and shows a spinner only once it has lasted about a second, so opening a
  terminal no longer opens on a blank pane. Connecting to your host names the session at once, and the workspace shows a
  status instead of a blank screen while its code loads. ([#1520](https://github.com/sisyphuslabs/doriterm/pull/1520))
- A close or rename question no longer lets itself be dismissed while its write is still going: Cancel waits, Escape and
  a click outside do nothing, and a refused write says why in the question that stays open.
  ([#1521](https://github.com/sisyphuslabs/doriterm/pull/1521))
- Sidebar sections read as groups: each title lines up with its rows and sits closer to them than to the section above,
  and the command palette leaves more room between its groups.
  ([#1522](https://github.com/sisyphuslabs/doriterm/pull/1522))
- The command palette's field shows a focus ring while you type in it, in light and dark themes.
  ([#1504](https://github.com/sisyphuslabs/doriterm/pull/1504))

### Phone

- A session whose tab has no name is titled by its agent instead of a bare number, in the header, the switch sheet and
  the stepper. Back says where it returns: to the space the session was opened from, else to the agents list. The header
  no longer repeats the agent counts the list already shows.
  ([#1440](https://github.com/sisyphuslabs/doriterm/pull/1440))
- The Spaces sheet can close a tab and start a new one: each tab row has a Close control, and each space ends with New
  tab. ([#1464](https://github.com/sisyphuslabs/doriterm/pull/1464))

### Mesh & relay

- Keys typed into a terminal on another machine while its connection is down are no longer lost silently: they wait, the
  terminal says it is reconnecting, and they are sent once, Ctrl+C first, when the machine is back. Keys still waiting
  after 10 s are dropped and you are told they were not sent.
  ([#1513](https://github.com/sisyphuslabs/doriterm/pull/1513))
- With two machines paired, each row in Settings > Machines other than the one you are on has Switch to this machine, so
  you move between them without pairing again. A stopped machine's row offers Retry instead.
  ([#1416](https://github.com/sisyphuslabs/doriterm/pull/1416))
- In the web app and the installed app on a phone, a machine reached through the relay answers sooner on a network that
  reaches the relay through a far city on some connections and a near one on others: the three connections the app tries
  open together instead of one after another, so the nearest one can win. Notifications and their answers open one
  connection instead of three. ([#1437](https://github.com/sisyphuslabs/doriterm/pull/1437))

## v0.1.12 - 2026-11-08

### New

- Settings has a Search field at the top of the section list: it narrows the list to the sections that hold what you
  type, and Enter opens the first. ([#1461](https://github.com/sisyphuslabs/doriterm/pull/1461))
- "N needs you" in the desktop status bar is a button: each click opens the next terminal that needs you, in turn.
  ([#1449](https://github.com/sisyphuslabs/doriterm/pull/1449))
- Holding Shift and dragging with the mouse selects text even under a program that tracks the mouse; the program is told
  nothing about the drag. ([#1396](https://github.com/sisyphuslabs/doriterm/pull/1396))
- A fresh install opens in the dark Night theme on a bundled monospace face that draws powerline glyphs. A person who
  already chose a light or system appearance keeps it. ([#1407](https://github.com/sisyphuslabs/doriterm/pull/1407))
- Links to doriterm.com, app.doriterm.com and the GitHub repository preview with a new card, and the card's address
  changes with the card, so Slack, KakaoTalk and X never show an old cached image.
  ([#1373](https://github.com/sisyphuslabs/doriterm/pull/1373),
  [#1458](https://github.com/sisyphuslabs/doriterm/pull/1458))

### Fixed

- A new tab shows its prompt one round trip sooner: the page asks for the new terminal's screen together with the
  terminal itself, instead of after it has started. Most noticeable on a machine reached through the relay.
  ([#1359](https://github.com/sisyphuslabs/doriterm/pull/1359))
- A terminal opened from the list no longer waits behind saving the tab, so a busy disk on that machine no longer holds
  back the prompt. ([#1360](https://github.com/sisyphuslabs/doriterm/pull/1360))
- Keys typed right after you come back to the app are no longer lost while it checks the connection: they are sent in
  the order typed once the connection answers, or on the next connection if it dropped, and never twice.
  ([#1432](https://github.com/sisyphuslabs/doriterm/pull/1432))
- A screen reader can jump straight to the terminals: the workspace marks its panes, and on a phone the agents list or
  the open terminal, as the page's main content. ([#1384](https://github.com/sisyphuslabs/doriterm/pull/1384))
- Command search and inline space rename keep their field label while you type, so a screen reader still names the
  field. ([#1451](https://github.com/sisyphuslabs/doriterm/pull/1451))
- Voice input's reading text and the note under a Keybindings row are no longer caption size; they meet the design
  system's size floors. ([#1459](https://github.com/sisyphuslabs/doriterm/pull/1459))

### Phone

- A round Read-only button beside the keyboard button turns the terminal read-only: one finger scrolls, a held finger
  selects and a drag takes what it reaches, and a tap reaches neither the program nor the keyboard. Tap the button again
  to end it. ([#1396](https://github.com/sisyphuslabs/doriterm/pull/1396))
- Tapping a space opens that space's own screen: its running tabs, each named after its tab or agent, and a New tab
  button for that space at the bottom. Back walks back one screen at a time and never leaves the app.
  ([#1406](https://github.com/sisyphuslabs/doriterm/pull/1406))
- The page no longer zooms when you tap a field or tap twice; pinching to zoom still works.
  ([#1382](https://github.com/sisyphuslabs/doriterm/pull/1382))
- Tapping the keys bar's Type field keeps the keyboard up, instead of the page's scroll to the field closing it.
  ([#1410](https://github.com/sisyphuslabs/doriterm/pull/1410))
- On an iPhone, the keys bar and its Type field sit directly on top of the soft keyboard, so what you type stays in
  view. ([#1431](https://github.com/sisyphuslabs/doriterm/pull/1431))
- The Gateway field brings up the URL keyboard and turns off automatic capitalization and correction.
  ([#1450](https://github.com/sisyphuslabs/doriterm/pull/1450))
- A screen reader finds Settings: the full-screen Settings sheet is announced as a dialog named Settings, as on a wide
  screen. ([#1414](https://github.com/sisyphuslabs/doriterm/pull/1414))

### Mesh & relay

- In a browser, every session goes through the relay and the status bar says Relay instead of Direct. The desktop app
  still reaches a host on the same network directly when it answers.
  ([#1422](https://github.com/sisyphuslabs/doriterm/pull/1422))
- A machine reached through the relay answers sooner on a network that routes some connections through a far city: the
  app opens three connections and keeps the one with the shortest way to that machine.
  ([#1402](https://github.com/sisyphuslabs/doriterm/pull/1402))
- A host with no mesh yet admits a browser as its first member, so one machine and one browser are enough to start.
  ([#1426](https://github.com/sisyphuslabs/doriterm/pull/1426))
- After a network split heals, a machine whose add was refused for the dial budget is added as soon as the budget has
  room, and a member that comes back online is added at once instead of after its retry delay.
  ([#1471](https://github.com/sisyphuslabs/doriterm/pull/1471))
- A failed mesh add no longer leaves a host process behind on each attempt, and retries keep their delay when the dial
  budget is full. ([#1442](https://github.com/sisyphuslabs/doriterm/pull/1442))

## v0.1.11 - 2026-11-08

### Machine mesh

- Pairing a machine adds it to your machines instead of replacing the one paired before: a phone reaches every computer it paired, each with its own connection, and the machine just paired is the one shown. (#942)

### Phone

- Back in the installed app walks out of a terminal to your agents list and only leaves the app from the list, so a
  terminal is no longer one Back gesture from closing Doriterm. (#975)
- An agent row's pin says what it pins: Pin <agent> to the top, on the button and as its tooltip. (#879)
- Tapping a notification while a terminal is open on a phone switches to its terminal in place, so one Back reaches the list instead of an extra list entry. (#999)

### Web app

- An iPhone keeps its paired identity across a reload. WebKit hands a stored X25519 `CryptoKey` back as null, so the app minted a new key on every load and the host refused the next session as an unknown device, adding a device on every re-pair; the key is now kept as bytes on a browser that cannot hold a `CryptoKey`, and a browser that can is unchanged. (#1333)

## v0.1.10 - 2026-11-08

### Terminal

- A terminal that reattaches after a reconnect holds the view at the end while the replay streams in, instead of the replay's rows climbing past the reader; scrolling up during the replay still leaves the view where it is. (#1041)
- Find in a terminal: Cmd+F (Ctrl+Shift+F elsewhere) or the palette opens a find bar that searches the screen and scrollback, marks every match, steps with Enter and Shift+Enter, and keeps each terminal's query (#732)
- A Korean syllable an input method commits as plain text, with no composition before it, reaches the program as soon as it is committed instead of waiting in the input until the next key. The Korean keyboards that build each syllable in the field (iPhone, iPad, Safari on a Mac) still keep the syllable being typed until it is finished. (#1104)

### Keys

- Cmd+Shift+R (Ctrl+Shift+R on Linux and Windows) renames the tab, beside F2; the desktop app's View > Force Reload no longer takes it. (#702)
- The default keys follow herdr-app's own key files, and `docs/keymap-herdr-app.md` lists every herdr-app key with what Doriterm does with it. Keys you changed in Settings > Keybindings stay as you set them. Changed defaults: (#702)
  - macOS: Cmd+W closes the tab (Cmd+Alt+W still does) and Cmd+Shift+W the focused pane; the desktop app's File > Close Window has no key. Cmd+N starts a new space.
  - Linux and Windows: Ctrl+1-9 select a tab and Alt+1-9 a space (swapped from before). Ctrl+Shift+PgUp / PgDn step through the spaces, so moving a tab is Ctrl+Alt+Shift+PgUp / PgDn. Alt+arrows and Alt+H/J/K/L move focus between panes and Alt+Shift+H/J/K/L swap them. Ctrl+Shift+N starts a new space.
- New space and Rename tab are in the command palette and the desktop app's Shell menu. (#702)
- Cmd+/ (Ctrl+? on Linux and Windows) opens a Keyboard shortcuts dialog listing your own keys, grouped as in Settings > Keybindings; the same chord closes it, and the command palette lists it too. (#733)

### Machine mesh

- A mesh takes any number of machines: the 12-member cap is gone, so adding a thirteenth machine no longer fails and mesh status no longer reports a limit. (#814)

### Connection and offline wording

- Connecting to a machine, and reconnecting after a drop or a wake, takes one round trip less: the first terminal call rides in the encrypted handshake and its answer comes back with the host's reply, about 0.2 s sooner on a far machine. The host acts on nothing else before the keys are confirmed. (#1271)

### Host install

- The setup tool's `verify`, `invite`, `join`, `pair` and `uninstall` use the same herdr-core `install` chose: an older or unrelated `hc` earlier in `~/.local/bin` is skipped instead of used. (#821)

### Website

- A link to app.doriterm.com now previews with the same card as doriterm.com. (#1341)

## v0.1.9 - 2026-11-08

### Terminal

- A terminal that goes quiet no longer jumps to the top of its history and scrolls back down: a direct connection to the host (the desktop app's own host included) now pings it every 30 s, so the host stops closing the idle session after 90 s and the terminal no longer reattaches. (#1040)
- A pane out of view no longer fetches its terminal's replay when the host ends the stream while the program still runs: it re-attaches once it is shown, and a program that ended in the meantime closes its tab then. (#1092)
- A syllable an input method is still composing is drawn as cells at the cursor, as Ghostty draws it: a wide one over two cells at the size it will have once committed (it no longer jumps on commit), underlined over the cells it covers, shifted left at the end of the row, following the cursor if output moves it, and with no cursor drawn meanwhile. (#674)

### Workspace

- Closing a tab while its layout could not be saved says "The layout was not saved" once, and the tab stays in view: the
  ended session's pane is no longer dropped a second time while the page has not heard the session end yet. (#1328)
- Right-clicking an agent or a space on the narrowed sidebar (the icon rail), or the title bar of a pane in a split,
  opens its menu with Rename, as a row on the full sidebar does. (#1348)

## v0.1.8 - 2026-11-07

### Terminal

- Ctrl+C, Ctrl+A and every other Ctrl+letter chord pressed in the middle of a Korean syllable reach the program: the syllable is committed first, then the chord's control byte, in Chromium's order (the key before the input method's commit) and in Safari's (the commit before the key). Another input method's Ctrl keys, such as Japanese conversion, stay with it. (#748)
- A program that left a synchronized update open (killed mid-frame) no longer keeps the screen frozen while a split divider is dragged: the screen paints one second after the update opened, however many resizes happen meanwhile. (#853)
- Many panes drawing output at once render as fast as in v0.1.2 again: a pane's link menu and held-selection menu no longer run while closed, which at 50 panes had raised the time the page spent in long tasks about threefold. (#842)

### Machine mesh

- An older app or `doriface-host mesh status` keeps showing the mesh of a host that writes a newer status document: a field it does not know is dropped instead of making it say the host is in no mesh. (#728)
- When the desktop app restarts this computer's own host, only that connection is dialled again: the sessions open on your other machines stay open instead of closing and reconnecting. (#1140)

### Joining a mesh

- A machine that joins through **Add a machine** while the host's own line to its core is reconnecting is shown as joined once the line is back, instead of the offer reading expired, and a computer clock set back during the offer no longer leaves its link up past the offer's end. (#834)

### Settings

- Changing a field under Advanced connection no longer brings back the machine that was shown when Settings opened: only the changed field is saved, onto the current settings. (#1006)

### Notifications

- A gateway that is not an address no longer leaves notifications silently behind: Settings, Notifications says the move to the new host failed, and notifications stay with the host they were on. (#890)

### Connection and offline wording

- When the app wakes and the host does not answer its check in time, the reconnect note says that check went unanswered instead of claiming the host sent no heartbeat. (#779)

### Host install

- `install.sh` registers the host with the paths you gave it: a `$`, a quote or a backslash in a path no longer changes it in the systemd unit, and a relative `--bin-dir` or `DORIFACE_HOST_STATE_DIR` is written as the absolute path it named when you ran the installer. (#834)
- The setup tool refuses a `--timeout` that is not a positive number of seconds before it changes anything, instead of waiting for the relay forever. (#821)

### Pairing

- A broken link made by `doriface-host mesh pair` says to run `doriface-host mesh pair` again, not `doriface-host pair`, and a typed code the host refuses says it may be a mesh invite, which `doriface-host mesh join` takes, instead of only that it was used. (#727)

## v0.1.7 - 2026-11-07

### Workspace

- While the sidebar filter holds a query, a machine's header offers no fold button, since every machine shows its matches; its folded state is as it was once the filter is cleared. (#850)
- An added machine's spaces and tabs keep their branch and diff facts while its mesh line redials, instead of losing them for a moment. (#913)
- When the host cannot answer with its terminals at first, the agents list says so with Try again, on a phone and in the desktop sidebar, instead of loading forever. (#819)
- A menu opened right after choosing from New tab's menu stays open and keeps the keyboard: the New tab menu used to hand the keyboard back to the new terminal as it finished closing, which could shut the menu just opened. (#1014)

### Joining a mesh

- `doriface-host mesh join --from-file <file>` reads the join link or code from a file, so it is never on the command line where other users of the machine can read it, and the setup tool's `join --from` now uses it. (#821)

### Web app

- An installed web app keeps one copy of the terminal's icon font: when a new version takes over, it drops the copies earlier versions left (about 1.2 MB each). (#967)

### Settings

- The Connect a machine tab draws a plug instead of a server, matching what it offers, and the Pair a device offer follows a change of connection mode on every screen that shows it. (#813)

### Website

- The doriterm.com landing page has a Pause animations button beside the theme switch: it stops the mesh scenes, the relay pipe and the pairing loop on their still frames, and the page remembers it. (#928)
- On the doriterm.com landing page, starting the Revoke scene again shows cloud-box at work until its revoke record lands, instead of an empty machine that reads working. (#936)
- The doriterm.com link preview shows the app's whole agent list: its third idle agent is no longer cut off by the sidebar's Settings footer. (#954)

### Reliability

- A pull request records its changelog line in a file of its own under `changes/unreleased/`, and the release writes those files into its notes, so open pull requests no longer conflict on CHANGELOG.md each time one merges. (#1261)

### Answering agents from the card

- A command, diff, new file, plan or question text that itself draws something shaped like a dialog no longer reads as the dialog: the card answers the dialog drawn at the bottom of the screen, with that dialog's own rows, and presses nothing when a row on the live screen does not say what the card showed for it. Where Codex's screen cannot tell the dialog from the agent's own text, the card offers nothing and the agent is answered in the terminal. (#776)

### Host

- `doriface-host --version` prints the host's version, and `/healthz` and the start-up line report the release the host was built from instead of 0.1.0 on every release. (#1039)

### First run

- The first-run guide's last step, "See it in the agents list", completes when the terminal you started or opened on this device is in the list, not on any terminal the host already had, and a screen reader hears each step complete and "You're set". (#834)

## v0.1.6 - 2026-11-07

### Mesh

- When a member's mesh line replaces an earlier ssh or command entry for the same machine, `mesh status` still names the replaced entry if the line was added on a later try, and a removal herdr refuses is retried with its reason shown instead of only logged. (#728)
- `doriface-host mesh status` and the Mesh panel show each member's line as herdr lists it when they read it: a line that finished connecting after the last membership change reads connected, instead of connecting until the next one. (#754)

### Terminal

- Closing a pane or a tab takes it off the screen at once, also on a machine reached through the relay: the program still ends behind it, and if it does not, a notice says so and the session keeps running. Before, the tab stayed until the host had answered two round trips, a second or more on a far machine. (#1271)
- A file pasted with the phone's Paste key while a Korean syllable is still composing lands after that syllable, as pasted text does, and a file refused for size says a size visibly above the 8 MB limit. (#827)
- On an iPhone or iPad Korean keyboard, a syllable still being typed is sent before Cmd+Backspace kills the line, so it no longer reaches the program after the kill, and a paste a browser inserts with no paste event sends only the pasted text. (#978, #988)

### Workspace

- Terminals a space takes in as tabs line up in the order they started: `t10` no longer comes before `t9`, so a terminal opened from the sidebar shows in the tab it started in. (#1269)
- A machine renamed while its layout was still loading keeps every tab's terminal: a tab that opened before this screen heard the new name no longer stays on "This terminal didn't open", and attaches at the machine's new name instead. (#852)

### Notifications

- The push bridge for the phone apps answers 429 once one device token gets more than 120 pushes a minute, so someone who learns a token cannot make that phone show alerts without bound. (#830)
- In the desktop app, Send test passes only when an agent's notification would: it waits for the app to follow the agents, then fails with the reason when notifications are off, the agents cannot be followed, every event is turned off, or this computer is muted, instead of showing a test that proves none of that. (#796)
- When this computer refuses Doriterm's notifications while they are on, Settings > Notifications shows Turn off beside Check again, and Send test and the event and machine switches wait until notifications are allowed. (#796)

### Settings

- A disabled field, number stepper, switch or menu item is dimmed with its own colours instead of fading as a whole, so its text stays readable and a switch still shows whether it is on, in every theme. (#1034)
- In a browser, the text-size keys Settings > Appearance shows step the terminals' text while Settings is open, as they do in the desktop app, and resizing the window between the Settings dialog and the full-screen sheet keeps the open section and a shortcut being recorded. (#859)
- With Settings open as a dialog, an agent in the pane behind it notifies again when it finishes or asks for input: the desktop app's notification and the host's web push both held back for that pane as if it were being watched, since the dialog leaves the workspace drawn behind it. (#993)

### Pairing

- Typing a pairing code looks its host up as soon as the first three characters are in, so the key check shows the moment the code is complete instead of most of a second later on a far relay; Pair asks the relay nothing more. (#1271)

### Pairing

- After you confirm a pairing, the workspace opens on the session the pairing just proved instead of reconnecting through the relay, so a newly added machine shows its terminals about a round trip and a handshake sooner (most of a second on a far machine). (#1271)

### Settings

- Settings is one place per question: this device, your machines, and pairing sit on their own screens with the same names everywhere, so each machine shows whether this host has a session open to it now, and this device shows how it reaches the host. (#772)

### Web app

- A disabled button reads as a labelled control instead of an empty grey pill, such as Pair before a code is typed. It is dimmed with its own quiet fill and a grey label of at least 4.5:1 in both themes, where it used to fade the whole button, label included. (#1031)

## v0.1.5 - 2026-11-07

### Desktop window

- The desktop window reopens where it was left even after a crash, a force quit or a kill: its position and size are saved once a move or a resize comes to rest, not only when the window closes. (#803)

### Terminal

- The terminal renderer is @wterm 0.5.9 with its Ghostty WASM rebuilt from the same source, keeping the Korean-input fixes on WebKit. (#823)

### Desktop updates

- An installed desktop app finds its updates: every release now carries electron-updater's feed (`latest-mac.yml`, `latest.yml`, `latest-linux.yml` and `latest-linux-arm64.yml`), one file per name listing both CPUs' downloads at the size and SHA-512 the release serves, including the macOS dmg after its notarization ticket is stapled. The macOS zip and the Windows installer ship with their `.blockmap`, so once the installed version has one too, an update downloads only the blocks that changed. (#924)

### Joining a mesh

- A phone can join a host by pointing its camera at the invite QR instead of typing the code: only a pairing link is accepted, an unrecognised code says so instead of looking for a host, and the camera stops as soon as the scan ends, is cancelled, or the page is left. (#855)

### Workspace

- An agent row shows how far its own todo list has got, as done/total (2/4), read from the list the agent draws: Claude Code's task list when its task tools are on (a long list's folded line counts too), and omp's TODO list with its phases added up. An agent with no list, or one that draws none, shows nothing, and while it waits on a question the row keeps its last count. (#673)
- The sidebar has a filter: the funnel button, Cmd+Alt+F on macOS or Ctrl+Alt+F elsewhere opens a field that narrows machines, spaces and agents to the rows whose shown labels match what is typed (letters in order, any case). The selected space and agent stay as context, a folded machine opens to show its matches, and Escape clears the query, then closes the field and returns to the terminal. (#673)

### Phone

- On a phone, Sort sits in the Agents header beside Search instead of on a row of its own above the list. (#950)
- On a phone, an agent row shows its "..." alone, with Pin to top as its first item, so the summary, machine and age have room. (#950)
- On a phone or tablet, every Settings switch takes a tap anywhere in the 44x44 box around it, Apple's touch minimum: its hit area was 2 px short and missed taps along its bottom edge. The switch looks the same. (#1030)

### The pairing pages name the app host

- Every page that tells someone where a phone lands after scanning the pairing QR code now names **https://app.doriterm.com**: the getting-started and install guides, the setup skill's instruction, and the landing page's illustrated panel, which still showed the older `doriface.omo.dev` address, one that keeps serving the same build. The desktop app and the web app already hand out the new one. (#977)

### Web app

- Your machines lists every machine this app holds its own connection to, each with that machine's own state, so a machine that is away is one row saying so. Each machine has its own connection, which means the others stay usable while one is gone. (#942)
- A link to app.doriterm.com now unfurls with a preview card: the app as captured, with "Open Doriterm in your browser." (#963)
- A machine's terminal count and a space's tab count stay on one line however many digits they have: on a phone, "19" no longer breaks into "1" above "9" in the Spaces list. (#899)

### Korean input after selecting text

- Typing Hangul right after dragging across a terminal's text composes again on macOS instead of arriving one bare jamo per keystroke: the terminal's input took focus while the drag's selection was still in place, and emptying it afterwards left the input focused with no caret, which is the state the Korean input method refuses to compose in. The selection is emptied first now, and the input's caret comes back with the focus. The selection stays held and painted, and Cmd+C still copies it. (#953)

### Settings

- The terminal preview in Settings draws its sample text at the size its rows are cut for: it asked for the configured point size while the row height comes from the pixel size the terminal renders at, so every line spilled a pixel past its box at every window size. (#955)

- Settings on a phone no longer shows the agent list's Pin and More buttons drawn over its sections: nothing of the workspace kept behind Settings is drawn while it is open. (#898)
- On a phone, the Settings tab strip's arrows that page to more sections are a full 44 pt tap each. (#900)
- With Settings open as a dialog, the band over the window's buttons still moves the desktop window, even when Settings is the first screen and the workspace behind has drawn nothing yet. (#969)

### Pairing from a phone

- The pairing link a phone opens points at **https://app.doriterm.com**, the app's own host, instead of the old `doriface.omo.dev` address; a link from either host still opens the pair page while the move completes. The desktop app accepts a pair link on both hosts for the same reason. (#759)

### Choosing the phone's keys

- Settings > Keyboard puts the keys bar in your own hands: the bar itself at the top, the keys it carries with the order you set by dragging or by keyboard, and Add keys for the ones you took out. Packs (Navigation, Ctrl chords, Tmux, Coding agents) are rows you switch on, and Your keys carries your own entries — a label plus the exact bytes or chord it sends, checked against the chord grammar so a bare modifier is refused rather than sent as text. The bar belongs to the host the phone talks to, so an iPhone on a Linux machine is offered no Command key. (#770)

### The brand files are named for Doriterm

- The web app's brand art and the script that turns it into icons name the product that ships, `doriterm-*`; the files the app serves keep their paths, so nothing a browser loads changes. (#917)

### Machine mesh

- A phone or another client can join the mesh as its own member rather than as a guest of one computer, and the approval row says what that gives it: control of every machine in the mesh. Every machine has to read the new format before one may join, and a client that does not is turned away with that reason. (#942)

- A machine whose mesh line drops for a moment, as on any relay hiccup, no longer flips to offline in the web app with all its tabs: it keeps reading connected while the line comes back, and reads offline only after 75 s without it, as a laptop that went to sleep still does. (#909)

### Settings

- Settings holds machines and their membership on one screen: the computers this host reaches are listed with their own state, a machine added by hand keeps its own route, connecting a machine joins it to your mesh, and the joins that need your approval sit on the same screen; the advanced-connection settings move into This device. (#942)
- Settings is one place per question: this device, your machines, pairing, and the advanced connection sit on their own screens with the same names everywhere, so each machine shows whether this host has a session open to it now, and this device shows how it reaches the host. (#772)

### Notifications

- Notifications say why they are not arriving: the app reports when the OS refuses a notification, with the remedy, retries a subscription that failed, and says how many agents are already waiting. (#783)

### The phone

- Korean typed straight into the terminal on an iPhone, an iPad or Safari on a Mac reaches the program as the syllables you see, instead of separate letters (`한글` used to arrive as `ㅎㅏㄴㄱㅡㄹ`); the syllable you are still typing shows at the cursor until it is finished. (#960)
- The key bar's Type field shows the whole line you are writing: it takes a row of its own above the keys, wraps and grows, and every key stays in reach under it. A line you have not sent yet is still there when the keyboard closes and opens again. (#960)

### Fonts, Korean text and the terminal

- Nerd Font icons, powerline separators, box drawing, braille spinners and agent marks such as `⏺ ⎿` are drawn from fonts the app ships, so they show on an iPhone instead of empty boxes. The icon font is only downloaded the first time a terminal shows an icon. (#960)

### Website

- The doriterm.com landing page opens on the app itself, its desktop window and phone with OmO first, then shows your machines as one mesh around the relay: a machine is dialed only after its signed admit record reaches every member, and a revoked one keeps working until its revoke record lands. It says who makes it, the people behind Dori and OmO, its buttons stack evenly on phones, and its social card shows the app as captured. (#927, #947)

### The host installer

- The host installer and the command the web app prints to join a mesh fetch from the product's own repository, and the installer's messages, help text and systemd description say the product's name. (#922)

## v0.1.4 - 2026-11-06

### The product is Doriterm

- The app is **Doriterm** everywhere a name shows: the bundle and its executable, the window title, the About and Help menus, notification titles, the PWA manifest and the tab title, the sidebar, the first-run and pairing copy, the exported terminal and keybinding files, the docs, and every GitHub link. The app id, the storage directory, the local keys, the `doriface://` link scheme and the wire contract stay as they are, so an installed app keeps the computer it paired and its settings. (#739)
- Upgrading from 0.1.x: the app id and the storage folder do not move, so an update keeps the devices and settings an install already has. What changes on disk is the name: a macOS install that updates in place keeps its existing bundle folder (`/Applications/doriface.app`) and shows Doriterm in the Dock and menus, while installing the dmg fresh gives `/Applications/Doriterm.app`; the Linux deb launches as `/usr/bin/Doriterm`; the Windows installer updates the folder it recorded before. If you install the new dmg while the old one is still in /Applications, remove the old doriface.app; an in-place update does not need this. (#739)

### The hosted web app

- The hosted web app answers at **https://app.doriterm.com** (staging at https://staging.app.doriterm.com). https://doriface.omo.dev keeps serving the same build, so an installed app and links already shared keep working. (#857)

### Host install

- On macOS, running `install.sh` again over a host already installed waits for launchd to unload the old LaunchAgent before it registers the new one, instead of failing with `Bootstrap failed: 5`. (#908)

### Settings

- Settings opens as a dialog over the workspace on a wide screen: the terminals stay in view behind it and keep drawing, so a theme, density or text-size change shows on them as it is made, and Escape or a click on the dimmed backdrop returns to the focused pane (in the desktop app the strip over the window's title bar still moves the window). Appearance gains a Text size row beside theme and density. A phone keeps the full-screen sheet. (#843)

### Website

- The doriterm.com landing page shows OmO running in the hero window and the machines of a fleet as a dot matrix around the relay, and introduces the people who make it. (#911)

### Native apps

- The push bridge keeps a device's subscription when FCM answers a bare 404, and stops reading a chunked request body at its size cap. (#838)

### Documentation

- The GitHub social preview uses the landing page's Timeless card, and the design and architecture docs name what they cite correctly. (#802, #804, #866)

## v0.1.3

### This computer on the relay, and pairing from a phone

- One step installs a host on Linux or macOS: `install.sh` (a release asset) checks the download against `SHA256SUMS.txt`, installs herdr-core when `hc` is missing, registers the host as a user service that starts at login and restarts if it stops, and prints the pairing QR code, link and code — running it again upgrades in place, and `--uninstall` removes it and keeps the keys. The code waits for a host that is still starting and for the relay to register it, so the first code it prints works. (#721)
- The host the desktop app starts joins the relay, so a phone or another computer can pair with this computer by code or link and reach its terminals. (#597)
- Settings > Connections has **Pair a device**: it asks this computer's host for a fresh offer and shows its QR code, link, 8-character code, fingerprint and expiry, then the device that used it — no terminal and no CLI. (#638)
- Settings > Connections lists the devices paired with this computer and revokes one after asking: its session ends at once, its notifications stop and its key is refused, so a lost phone no longer needs a terminal on this computer. (#729)
- The web app is hosted at https://doriface.omo.dev, and the pairing QR code (in **Pair a device** and from `doriface-host pair`) opens its pair page on a phone, with the host's key ready to check. The link for another computer stays `doriface://pair#…`. (#713)
- A pair link printed with no `--web-origin` opens the desktop app, instead of a hostname the release never served. (#595)
- A plain LAN Direct address works in the desktop app: the app forwards the page's bytes and reads none of them. (#601)
- A saved Direct address carries the session with it, and the relay is its fallback. (#598)
- Settings keeps naming the host it is paired with after that host stops answering, instead of showing its 26-character id. (#600)
- A newly paired device walks through its first run: pair, start or open an agent, then see it in the agents list. Each step completes on its own, the guide can be skipped, and Settings > Device > **Getting started** shows it again. (#723)

### Answering agents from the card

- The card pinned over a waiting agent answers every prompt shape Claude Code and Codex draw, not only Allow or Deny: each of the agent's own rows with its key, its questions (one or several in a row, multi-select, a typed answer), and a plan to approve. It shows what the agent said above the question, the directory it works in, and the diff or file it touches, and a file it names opens read-only. Every answer is still checked against the live screen first. (#736)
- A notification offers its prompt's own rows: a one-question prompt's rows become the notification's actions, the No row answers from the notification, any other row opens the app and its page sends the answer, and the answer is still checked against the live screen. Several steps or a typed answer offer no rows, and a tap opens the card. (#745)

### A browser on the mesh, and the installed web app

- A browser with no account and no pairing opens the web app, follows an invite link a member sent, checks the host's fingerprint and lands on the mesh's terminals; a revisit needs no new invite. (#716)
- A mesh invite (`&m=1`) is no longer read as a device invite: the web app says it adds a machine, with the command that does, instead of reporting a link that was already used. (#716)
- The installed web app carries its own app id and language, ships a maskable icon at 192 as well as 512, and opens standalone from an iOS home screen with its own title and status bar. (#715)
- The hosted web app sends a Content Security Policy: its own scripts and the terminal's wasm, this origin and the relay, nothing else, and every deploy probes for the header. (#743)

### Machine mesh

- A machine you had already added over ssh or with a via is replaced by its mesh line under the same name, and mesh status and the Mesh panel say what kind of entry it replaced. Its open tabs and layout carry over. (#712)
- Settings > Mesh shows the mesh this computer is in instead of "Not in a mesh": the host publishes its mesh status like its own facts, and a host in no mesh writes that it is in none, so a mesh it left is never read as the current one. (#761)
- **Add a machine** is one command: the dialog asks this host for a single-use mesh offer and shows one `curl -fsSL …/install.sh | sh -s -- --join '<link>'` to run on the machine to add, which installs the host, runs it as a service and joins this host's mesh; the cores then add each other as machines, and the dialog says when it joined, with the three hand-run steps left under **Advanced**. (#831)

### The phone

- The phone terminal has a held touch, a field and a two-slot keys bar, with the input beside a scrolling key strip and a keyboard toggle that stays put. (#680, #682)
- A one-tap ^C sits after Esc in the phone key row. (#678)
- A syllable still composing is finished before a key-bar key, a chord or a paste, so the bar never eats it and never sends the syllable twice. (#718, #738)
- The phone draws its sort control only when an agent can be sorted. (#657)
- The phone's list says it is loading until the host's first list answers, instead of showing "No terminals yet" on every load. (#807)
- A held touch's menu stays open when the finger lifts, and the selection it made survives: the tap a lift would make belongs to the hold, not to the menu. (#845)
- An agent row's Pin and More are drawn on a touch screen, 24 px apart, so each takes a 44 px tap instead of waiting for a hover that never comes. (#808)

### Native apps

- A push bridge for the coming iOS and Android apps: the host's encrypted notices reach them through APNs and FCM, and the bridge never holds a key that opens one. (#717)
- An Android app around the same web build, with its notifications through the bridge and Allow and Deny on the notification itself. (#810)
- An iOS app around the same web client: a Notification Service Extension opens each notice with the app's own keys, so the text is shown without the bridge or Apple reading it. (#846)

### Spaces, tabs and the sidebar

- Ctrl+1-9 show the space at that place in the sidebar, and Cmd+Alt+] and Cmd+Alt+[ step through the spaces and wrap (Ctrl+Alt on Windows and Linux). There the tab number chords move from Ctrl+1-9 to Alt+1-9. (#626)
- A space moves up or down within its machine, by drag or from its menu, and the order is written to the shared layout document, so every device of the host reads it without a reload. (#622)
- A space's menu can close the whole space: it says how many tabs and terminals go, ends every program they run, and takes the space out on every device. (#620)
- A tab's menu hands the keyboard to the question its item opened, so a rename typed at once is kept. (#591, #632)
- Right-clicking a sidebar row opens its menu, so Rename is there without the "..." button. (#720)
- The sidebar toggle takes a click on macOS with the sidebar hidden or in a rail, a click on it is not a window drag, and the tab strip still moves the window beside it. (#646, #659, #690)

### Fonts, Korean text and the terminal

- A latched Ctrl, Alt or Cmd reads a Hangul letter as its 2-set key, and a Ctrl chord whose key is a Hangul letter sends that physical key's control byte, so ctrl+ㅊ is ^C. (#675, #714)
- A fallback Hangul face is sized to Ghostty's ideograph width, not the whole two cells. (#658)
- Wide glyphs in a terminal that opened in a tab not shown are drawn once the tab is shown. (#649)
- A press's selection is held by the terminal rather than the document, so IME composes after a drag-select. (#593)
- A resize keeps the terminal's view: a following terminal keeps following through a divider drag or the phone keyboard, a program's redraw during one is written whole instead of paced, and only a scroll of your own stops it following. (#811)
- An image pasted into a terminal, or a file dropped on one, goes to that terminal's machine — this one or an added one — and its path is pasted there, so an agent on that machine can read it; text and Ctrl+V paste as before, and **Paste image** can be bound in Settings > Keybindings. (#742)

### Connection and offline wording

- An attempt has a deadline that bounds the whole attempt and grows after each timeout, so a link that never settles cannot leave the page on "Connecting"; a direct race whose host stalls falls back to the relay. (#719, #740)
- A relay that never answers the upgrade fails at its bound instead of holding the connect open. (#631)
- The page waking runs a reconnect at once, and a link that keeps dropping keeps backing off. (#654)
- A connection that answered no hello still opens, so a name never fails a session. (#633)
- A layout write whose link drops under it says so plainly, never the closed link's raw cause. (#724)
- Coming back from Settings keeps your terminals running instead of replaying their history. (#607)
- Moving this device to another host in Settings moves its notifications with it: the host it leaves drops the subscription and the new host gets it. (#627)
- A page that comes back — a tab shown again, a page restored from the back/forward cache, the network returning — while its link still looks open asks the host once, and a link that does not answer within 10 seconds is dropped and reconnected at once instead of leaving the terminal frozen until the 45-second heartbeat gives up; a link that answers, even with a refusal, is left alone. (#775)
- A pane in a tab that is not on screen no longer re-attaches and pulls its 2,000-line scrollback over the link, so the pane in front of you and your typing do not compete with a replay nobody sees; it attaches when the tab is shown. (#731)

### A core this client cannot use

- A core the client cannot use fails for good instead of being retried forever, and says which side to update from one shared version floor; a core build missing a method the workspace calls says so at the handshake. (#662, #686, #689, #697)

### Done, idle and errors

- An agent that finished while its pane was not on screen keeps its dot, its row under **Done** and its space's mark until this screen shows that pane; another device that never showed it still says Done. (#628)
- A render error shows a crash screen or a region notice with Try again, never a blank or bare screen. (#660)

### Linux

- The AppImage carries its own FUSE runtime, so stock Ubuntu 24.04 opens it without installing FUSE 2 first. (#629)

### Website

- doriterm.com has a landing page: "Your devices. One terminal.", the app shown live from its own components, pairing by QR or code, the mesh, and the relay as a ciphertext-only pipe, each as an animation that stops under reduced motion, in dark and light, with OmO as the agent shown first. (#735, #880)

### Reliability

- A launch still opening when the host stops is ended, so its core cannot outlive the host. (#599)
- The host reads one typed plan document that is open unless it names a limit or a feature, and a document that cannot be read as one stops the host instead of reading as an open plan. (#606)
- Many test, CI and documentation fixes, so problems are caught before a release instead of after. The phone keys bar's keys, packs and custom keys are now a stored model, and a modifier held in the bar now covers Home, End, Page Up, Page Down, Delete and F1 to F12 as well as the arrows, so a keyboard attached to a phone carries the modifier too. (#605, #608, #613, #617, #624, #681, #683, #685, #687, #695, #711, #725, #741, #762, #763, #765, #784, #785, #788, #815, #826, #828, #847, #863, #872, #876, #885)

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
