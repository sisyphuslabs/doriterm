# Production paired redesign QA — 2026-11-26

Production `https://app.doriterm.com`, real relay and a disposable host, with
two independent Chromium browser contexts. The last verified web deploy was
from `10a3c8799f02a847e3736e9c22254cdd7fa64f51` (T2 #2811, with T4 #2796
already merged). The public entry immediately after the QA served
`/assets/index-CYAu4xAW.js`.

| Scenario | Observation | Verdict |
|---|---|---|
| Desktop, 1440×900 | Paired and opened the QA terminal; `echo` reached the terminal; rendered grid and host grid both 35×115 | PASS |
| Phone, 390×844, watching | Independent device opens the same terminal; rendered grid 28×38, but host remains 35×115 after simulated app background and return | PASS |
| Phone begins input | Show keyboard claims host grid 28×38 | PASS |
| Key row | Exactly one Keys pill and one Actions pill, same row, key target height ≥44 px | PASS |
| Arrow pad | Exactly one visible four-arrow pad | PASS |
| Input card | Separate input card sends `echo qa-card-ok` to the real test terminal | PASS |
| Previously active phone returns | Desktop claims grid 35×115; phone returns and reclaims 28×38 | PASS |

The browser's visibility change was emulated; it was not a physical iOS or Android
app switch. No personal account, existing mesh, or user terminal was used.
Screenshots preserve the tested UI and relay connection; machine/path labels
only have been redacted.

The isolated core started with zero terminals and zero registered machines.
The disposable host had zero paired devices before testing, two during testing,
and zero after revocation. Both browser contexts were closed; the test terminal,
host, and core were stopped, and the loopback listening port was released.

Web deployment: https://github.com/sisyphuslabs/doriterm/actions/runs/45727331175
