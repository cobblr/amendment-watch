# Amendment Watch

A one-page lab card for XRPL mainnet amendment status. It reads the public `feature` method and, when that call works, cross-checks majority times against the `Amendments` ledger entry. No wallet, no backend, no secrets.

Independent Cobblr Labs experiment. Not affiliated with Ripple. Not financial advice.

This repository is the home of the card. `index.html` is at the repository root.

## Open it

Clone the repo, then from the repository root:

```sh
python3 -m http.server 8080
```

Then open [http://127.0.0.1:8080/](http://127.0.0.1:8080/).

Double-clicking `index.html` can work, but some browsers block API calls from `file://` pages. If the card says it could not reach the cluster, use the command above.

The page refreshes on its own about every 60 seconds. The Refresh button fetches immediately.

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

## What the card shows

- **In majority** — `enabled` is false and `majority` is set. This is the screenshot row. Names starting with Batch, Permission, or Delegation get a watch mark.
- **Voting** — not enabled, no majority, and `count` greater than 0.
- **Quiet / parked** — collapsed. Other known amendments that are not enabled, with a missing or zero count. Enabled amendments are not dumped here.
- **Enabled · name watch** — enabled amendments whose names match Batch, Permission, Credentials, or Delegation. The API does not include an enable time, so this is a name filter, not a chronology.

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
     = 1789471201
     = 2026-09-15 14:06:41 UTC

estimate = unix + 14 * 24 * 3600
         = 1789471201 + 1209600
         = 2026-09-29 14:06:41 UTC
```

That estimate holds only while majority is continuous. If support drops to 80% or less, the ledger clears the majority time and the two weeks start over. The network applies the check on flag ledgers (every 256 ledgers, on the order of 15 minutes), so the second on the card is not the exact ledger that flips the amendment on.

Official description: [Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments).

## Vote counts

On that same live response, amendment objects had `enabled`, `name`, `supported`, and (when relevant) `majority`. They did not include `count`, `threshold`, or `validations`. Those fields are shown when a server sends them. Their absence is not a zero, and a validator that stays silent is not a yes.
