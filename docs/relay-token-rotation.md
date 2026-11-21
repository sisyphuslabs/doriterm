# Rotating the relay read token

CI reads the private relay with `DORIFACE_RELAY_READ_TOKEN`, a fine-grained personal access token that expires (#38).
This is the whole procedure: what the token may read, what breaks when it lapses, and the order that swaps it without a
window where nothing works.

## What the token is

- `DORIFACE_RELAY_READ_TOKEN`, a fine-grained personal access token whose resource owner is the organization that owns
  this repository.
- Repository access: the private relay repository, and no other.
- Permissions: **Contents: read-only**. GitHub adds **Metadata: read-only** to every fine-grained token; nothing else is
  granted — no `workflow`, no `pull_request`, no access to any other repository.
- Used by the `Relay e2e` job of `.github/workflows/ci.yml`, step "Fetch the private relay". That step hands it to git
  through a step-scoped credential helper, so it never appears in a clone URL, an argument or the log.
- `RELAY_REPO` is a separate secret naming the relay repository (`owner/name`); a rotation does not change it.
- The day it expires is recorded in `relay-token.json`. `bun tests/relay-fetch/token-expiry.ts` prints a GitHub
  annotation from 60 days before that day, and an error once it has passed; the `Check` job runs it on every push, so
  the date reaches the run page without anyone watching a calendar.

## What breaks on the day it expires

`Fetch the private relay` fails, and `Relay e2e` with it, on every push and every same-repository pull request. Pull
requests from forks are unaffected: they get no secrets and skip those suites with a notice. Local runs are unaffected
too — `bun run check` never needs the token, and `bun run relay:test` says why it cannot fetch the relay.

## Rotating it

The order matters: the new value has to work before the old one stops, and no copy of the old one may outlive the swap.

1. **Create the replacement.** Settings → Developer settings → Fine-grained personal access tokens → Generate new token.
   Resource owner and repository as above, Contents read-only, expiration as long as the organization's policy allows.
   GitHub shows the value once, on its own page; do not copy it anywhere else.
1. **Update the Actions secret.** Repository Settings → Secrets and variables → Actions → `DORIFACE_RELAY_READ_TOKEN` →
   Update. It is the only secret that changes.
1. **Update the credential vault entry** that keeps a copy of the token, in the same step as the secret.
1. **Prove it before retiring the old token.** Run the workflow at the default branch's head and confirm that
   `Fetch the private relay` and `Relay suites against the private relay` both pass.
1. **Record the new day** in `relay-token.json`, one line in one pull request, so the warning counts to the new date.
1. **Revoke the old token.** Delete the retired one from the token list, then let the next run pass: that run is what
   proves the secret and the vault copy hold the new value, and that nothing still reads the old one.
1. **Close the rotation issue** with the run link and the new expiry day, and open the follow-up issue for the next
   rotation if the new token still expires.

## A credential that does not expire

A GitHub App installation token removes the calendar entirely: an App installed on the private relay repository with
Contents read, and a step that mints a short-lived token for it (`actions/create-github-app-token`). That route needs an
App registration and a secret only an owner can create, so it is a repository-settings change rather than a rotation;
this repository's CI keeps the fine-grained token until one exists.

## Checking without touching the secret

```sh
bun tests/relay-fetch/token-expiry.ts   # the days left, and the annotation CI would print
bun run check                           # every suite except tests/relay
bun run relay:test                      # the relay suites, for someone with access to the relay
```

## What this repository never does

`relay-token.json` holds the expiry day and nothing else, and the checker refuses a record with any other field, so the
file the alarm reads can never become the place a token value lands. Never paste the token into an issue, a pull
request, a commit or a log: a value that appears on any of those surfaces is revoked as a rotation that leaked.
