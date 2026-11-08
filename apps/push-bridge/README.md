# @doriface/push-bridge

Forwards the host's Web Push notices to the iOS and Android apps (#705). The host posts to the bridge exactly what it posts to a browser's push service: one RFC 8291 `aes128gcm` record signed with its VAPID key. The bridge checks the request and hands the ciphertext, unchanged, to APNs or FCM. Only the app holds the key that opens it.

| Endpoint                               | Forwarded to                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /v1/apns/<device token>`         | APNs production, an alert with `mutable-content` for the Notification Service Extension |
| `POST /v1/apns-sandbox/<device token>` | APNs development (debug builds)                                                         |
| `POST /v1/fcm/<registration token>`    | FCM HTTP v1, a data-only message                                                        |

Answers: 201 sent, 410 the token is unregistered (the host drops the subscription), 429 throttled, 401 no valid VAPID token for this origin, 400 or 413 not one small `aes128gcm` record, 503 the provider is not configured, 502 anything else upstream.

`createBridge` in `src/bridge.ts` is a plain `fetch` handler, so it runs on Workers, Bun or Node. `src/worker.ts` is the Workers entry; `wrangler.toml` deploys it at `push-doriface.omo.dev`.

Credentials (owner step, not in the repo): an APNs auth key (`APNS_PRIVATE_KEY`, the `.p8` file, with `APNS_KEY_ID` and `APNS_TEAM_ID`), the app's bundle id (`APNS_TOPIC`), and a Firebase service account JSON (`FCM_SERVICE_ACCOUNT`). A provider with no credentials answers 503 and the other keeps working.

What a device token allows: the bridge checks that a request carries a valid VAPID token for its own origin, but it does not tie a device token to the VAPID key the app subscribed with (browser push services do, through `applicationServerKey`). The device token is the secret: it lives only in the app and on the host that holds the subscription. Someone who learns one can make that device show the fixed "Open doriface" alert, never a readable notice, and only so often: the deployed bridge allows each device token 120 pushes a minute (#830), counted per Cloudflare location by the `TOKEN_LIMIT` rate limiting binding in `wrangler.toml` under a SHA-256 of the provider and token, never the token itself. A push past the limit is answered 429 and forwarded nowhere; the host treats 429 as a failed push and keeps the subscription. One host sends a terminal at most one notice of a kind per 30 s, so a real host stays under the limit unless dozens of its agents change state in the same minute. Requests the bridge refuses (no valid VAPID token, a malformed body) are not counted.
