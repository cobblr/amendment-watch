# Amendment Watch

A one-page lab notebook for XRPL mainnet amendment status. When something is in majority, the page is a receipt on ruled paper: amendment name, countdown, majority time, estimated enable, and a stamp for the source ledger. Voting, parked names, and a short name-watch of already-enabled amendments sit in folds under that receipt. If nothing is in majority, the page says so instead of inventing a countdown.

It reads the public `feature` method and, when that call works, cross-checks majority times against the `Amendments` ledger entry. No wallet, no backend, no secrets, no build step.

Independent Cobblr Labs experiment. Not affiliated with Ripple. Not financial advice.

`index.html` is at the repository root. Serve the folder; nothing to install.

## Open it

Clone the repo, then from the repository root:

```sh
python3 -m http.server 8080
```

Then open [http://127.0.0.1:8080/](http://127.0.0.1:8080/).

Double-clicking `index.html` can work, but some browsers block API calls from `file://` pages. If the page says it could not reach the cluster, use the command above.

The page refreshes on its own about every 60 seconds. The refresh control fetches immediately.

## Endpoint

Primary request:

```http
POST https://xrplcluster.com/
Content-Type: application/json

{"method":"feature","params":[{}]}
```

Fallback, same body: `https://xrpl.ws/`.

If browser HTTP is blocked, the page tries `wss://xrplcluster.com` and then `wss://xrpl.ws` with `{ "command": "feature" }`.

Both HTTPS hosts answered with `Access-Control-Allow-Origin: *` when this page was written, so a normal browser `fetch` is enough. No proxy.

A second call, `ledger_entry` with `amendments: true` on the validated ledger, checks that each `majority` value matches `Majorities[].Majority.CloseTime`.

## What the page shows

- **Hero** — one amendment in majority (`enabled` false and `majority` set). Batch, Permission, or Delegation names come first; otherwise the earliest majority. Large name, countdown (`6d 0h 15m`), Chicago and UTC times. Further amendments in majority are shorter lines under that receipt.
- **Empty** — nothing is in majority. A short note, no countdown.
- **Stamp** — `cobblr labs · host · ledger N · refreshed …`
- **Arithmetic** — collapsed Ripple-epoch math for each majority amendment.
- **Caveats** — collapsed. The 80% / 14-day rule, flag ledgers, and missing vote counts.
- **Voting** — collapsed. Not enabled, no majority, `count` greater than 0.
- **Quiet / parked** — collapsed. Other known amendments that are not enabled, with a missing or zero count. Enabled amendments are not listed here.
- **Enabled** — collapsed name watch. Enabled amendments whose names match Batch, Permission, Credentials, or Delegation. The API does not include an enable time.

## Time math

Checked live on 23 Sep 2026 against `https://xrplcluster.com/`.

`BatchV1_1` was the only amendment in majority:

- `enabled`: false
- `majority`: `842796401`
- The same integer was `CloseTime` on the Amendments ledger

Treating `842796401` as Unix time lands in 1996. It is Ripple epoch time: seconds since 2000-01-01 00:00:00 UTC.

```text
unix = majority + 946684800
     = 842796401 + 946684800
     = 1789481201
     = 2026-09-15 14:06:41 UTC

estimate = unix + 14 * 24 * 3600
         = 1789481201 + 1209600
         = 1790690801
         = 2026-09-29 14:06:41 UTC
```

That estimate holds only while majority is continuous. If support drops to 80% or less, the ledger clears the majority time and the two weeks start over. The network applies the check on flag ledgers (every 256 ledgers, on the order of 15 minutes), so the second on the page is not the exact ledger that flips the amendment on.

Official description: [Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments).

## Vote counts

On that same live response, amendment objects had `enabled`, `name`, `supported`, and (when relevant) `majority`. They did not include `count`, `threshold`, or `validations`. Those fields are shown when a server sends them. Their absence is not a zero, and a validator that stays silent is not a yes.
