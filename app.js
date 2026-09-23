// Amendment Watch
// Reads the public XRPL `feature` method. No wallet, no secrets.
//
// Time base, checked against mainnet on 2026-09-23:
// `majority` is Ripple-epoch seconds (2000-01-01 00:00:00 UTC), the same
// clock as Amendments.Majorities.CloseTime. It is not Unix time.
// Unix seconds = majority + 946684800.
// Estimated enable = that Unix time + 14 days, if majority never drops.

const HTTP_ENDPOINTS = [
  "https://xrplcluster.com/",
  "https://xrpl.ws/",
];

const WS_ENDPOINTS = [
  "wss://xrplcluster.com",
  "wss://xrpl.ws",
];

const RIPPLE_TO_UNIX_SEC = 946684800;
const MAJORITY_WINDOW_SEC = 14 * 24 * 3600;
const REFRESH_MS = 60000;

const statusEl = document.querySelector("#status");
const appEl = document.querySelector("#app");
const refreshBtn = document.querySelector("#refresh");

let refreshing = false;
let lastFetchMs = 0;
let snapshot = null;

const chicagoFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const utcFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

refreshBtn.addEventListener("click", () => {
  refresh();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastFetchMs > REFRESH_MS - 5000) {
    refresh();
  }
});

setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);

setInterval(paintCountdowns, 30000);

refresh();

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  try {
    const data = await loadAmendments();
    snapshot = data;
    lastFetchMs = Date.now();
    render(data);
    const when = chicagoFormat.format(new Date(lastFetchMs));
    const ledger = data.ledgerIndex ? ` · ledger ${data.ledgerIndex.toLocaleString("en-US")}` : "";
    statusEl.textContent = `Last refreshed ${when}${ledger} · ${labelEndpoint(data.endpoint)} · auto-refreshes about every 60s`;
  } catch (error) {
    statusEl.textContent = "Last refresh failed.";
    appEl.replaceChildren(errorBox(error));
  } finally {
    refreshing = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

async function loadAmendments() {
  let lastError = null;
  for (const endpoint of HTTP_ENDPOINTS) {
    try {
      const feature = await postRpc(endpoint, "feature", [{}]);
      const amendments = normalizeFeatures(feature.features);
      let ledger = null;
      try {
        ledger = await postRpc(endpoint, "ledger_entry", [
          { amendments: true, ledger_index: "validated" },
        ]);
      } catch (ledgerError) {
        ledger = { error: ledgerError };
      }
      return pack(endpoint, amendments, ledger);
    } catch (error) {
      lastError = error;
    }
  }

  for (const endpoint of WS_ENDPOINTS) {
    try {
      const feature = await wsRpc(endpoint, { command: "feature" });
      const amendments = normalizeFeatures(feature.features);
      let ledger = null;
      try {
        ledger = await wsRpc(endpoint, {
          command: "ledger_entry",
          amendments: true,
          ledger_index: "validated",
        });
      } catch (ledgerError) {
        ledger = { error: ledgerError };
      }
      return pack(endpoint, amendments, ledger);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No public XRPL endpoint responded.");
}

function pack(endpoint, amendments, ledgerResult) {
  const closeTimes = new Map();
  let ledgerIndex = null;
  let ledgerNote = null;

  if (ledgerResult && ledgerResult.node) {
    ledgerIndex = ledgerResult.ledger_index || null;
    const majorities = ledgerResult.node.Majorities || [];
    for (const entry of majorities) {
      const row = entry.Majority || entry;
      if (row.Amendment && typeof row.CloseTime === "number") {
        closeTimes.set(row.Amendment.toUpperCase(), row.CloseTime);
      }
    }
  } else if (ledgerResult && ledgerResult.error) {
    ledgerNote = "Could not read the Amendments ledger entry to cross-check majority time.";
  }

  return { endpoint, amendments, closeTimes, ledgerIndex, ledgerNote };
}

function normalizeFeatures(features) {
  if (!features || typeof features !== "object") {
    throw new Error("Feature response did not include an amendments map.");
  }
  return Object.entries(features).map(([id, raw]) => ({
    id,
    name: raw.name || id,
    enabled: raw.enabled === true,
    supported: raw.supported !== false,
    majority: typeof raw.majority === "number" ? raw.majority : null,
    count: typeof raw.count === "number" ? raw.count : null,
    threshold: typeof raw.threshold === "number" ? raw.threshold : null,
    validations: typeof raw.validations === "number" ? raw.validations : null,
  }));
}

function postRpc(url, method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`${labelEndpoint(url)} HTTP ${response.status}`);
      const body = await response.json();
      const result = body.result || body;
      if (result.error) throw new Error(result.error_message || result.error);
      return result;
    })
    .finally(() => clearTimeout(timer));
}

function wsRpc(url, payload) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => {
      if (socket) socket.close();
      reject(new Error(`${url} timed out`));
    }, 12000);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, ...payload }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.status === "error") {
        reject(new Error(message.error_message || message.error || "WebSocket request failed"));
        return;
      }
      resolve(message.result || {});
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${url} WebSocket failed`));
    });
  });
}

function render(data) {
  const grouped = groupAmendments(data.amendments);
  const root = document.createElement("div");
  root.className = "stack";

  if (location.protocol === "file:") {
    const note = document.createElement("p");
    note.className = "rule";
    note.textContent = "Opened as a file. If the cluster blocks this, serve the folder with python3 -m http.server 8080 and use http://127.0.0.1:8080/.";
    root.append(note);
  }

  root.append(sectionMajority(grouped.majority, data));
  root.append(sectionVoting(grouped.voting));
  root.append(sectionQuiet(grouped.quiet));
  root.append(sectionEnabled(grouped.enabledWatch));
  appEl.replaceChildren(root);
  paintCountdowns();
}

function groupAmendments(amendments) {
  const majority = [];
  const voting = [];
  const quiet = [];
  const enabledWatch = [];

  for (const item of amendments) {
    if (item.enabled) {
      if (isKeywordWatch(item.name)) enabledWatch.push(item);
      continue;
    }
    if (item.majority != null) {
      majority.push(item);
    } else if (item.count != null && item.count > 0) {
      voting.push(item);
    } else {
      quiet.push(item);
    }
  }

  majority.sort((a, b) => a.majority - b.majority || a.name.localeCompare(b.name));
  voting.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  quiet.sort((a, b) => Number(isHighlight(b.name)) - Number(isHighlight(a.name)) || a.name.localeCompare(b.name));
  enabledWatch.sort((a, b) => a.name.localeCompare(b.name));
  return { majority, voting, quiet, enabledWatch };
}

function sectionMajority(items, data) {
  const section = document.createElement("section");
  section.append(head("In majority", String(items.length)));
  const rule = document.createElement("p");
  rule.className = "rule";
  rule.textContent = "More than 80% for 14 continuous days, then it can enable. The date is an estimate: majority time plus 14 × 24 × 3600 seconds. Support at or below 80% clears that timestamp and the clock starts over. The network checks on flag ledgers, about every 15 minutes.";
  section.append(rule);

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No amendment currently has majority without being enabled.";
    section.append(empty);
    return section;
  }

  const stack = document.createElement("div");
  stack.className = "stack";
  for (const item of items) stack.append(majorityCard(item, data));
  section.append(stack);
  return section;
}

function majorityCard(item, data) {
  const card = document.createElement("article");
  card.className = isHighlight(item.name) ? "card watch" : "card";

  const top = document.createElement("div");
  top.className = "card-top";
  const name = document.createElement("h3");
  name.className = "amendment-name";
  name.textContent = item.name;
  top.append(name);
  if (isHighlight(item.name)) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = "Watch";
    top.append(pill);
  }
  card.append(top);

  const kicker = document.createElement("p");
  kicker.className = "card-kicker";
  kicker.textContent = item.supported
    ? "In majority · not enabled yet"
    : "In majority · this server does not support the code";
  card.append(kicker);

  const times = majorityTimes(item.majority);
  const facts = document.createElement("dl");
  facts.className = "facts";
  facts.append(fact("Majority since", timeBlock(times.majorityMs)));
  const remain = document.createElement("div");
  const remainStrong = document.createElement("strong");
  remainStrong.className = "remain";
  remainStrong.dataset.enableAt = String(times.enableMs);
  remain.append(remainStrong);
  const remainNote = document.createElement("span");
  remainNote.className = "remain-note";
  remainNote.textContent = " if majority holds the whole time";
  remain.append(remainNote);
  facts.append(fact("Estimated enable", timeBlock(times.enableMs)));
  facts.append(fact("Countdown", remain));
  facts.append(fact("Votes", voteNode(item)));
  facts.append(fact("Ledger check", ledgerCheckNode(item, data)));
  card.append(facts);
  card.append(mathDetails(item));
  return card;
}

function mathDetails(item) {
  const details = document.createElement("details");
  details.className = "math";
  const summary = document.createElement("summary");
  summary.textContent = "Arithmetic";
  details.append(summary);
  const pre = document.createElement("pre");
  const majorityUnix = item.majority + RIPPLE_TO_UNIX_SEC;
  const enableUnix = majorityUnix + MAJORITY_WINDOW_SEC;
  pre.textContent = [
    `majority (Ripple epoch seconds)   ${fmt(item.majority)}`,
    `+ Ripple epoch offset             ${fmt(RIPPLE_TO_UNIX_SEC)}`,
    `= majority Unix seconds           ${fmt(majorityUnix)}`,
    `+ 14 × 24 × 3600                  ${fmt(MAJORITY_WINDOW_SEC)}`,
    `= estimated enable Unix seconds   ${fmt(enableUnix)}`,
    "",
    "Ripple epoch is 2000-01-01 00:00:00 UTC.",
    "A lost majority deletes this timestamp. The next gain starts a new 14 days.",
  ].join("\n");
  details.append(pre);
  return details;
}

function sectionVoting(items) {
  const section = document.createElement("section");
  section.append(head("Voting", String(items.length)));
  const rule = document.createElement("p");
  rule.className = "rule";
  rule.textContent = "Not enabled, no majority timestamp, and a vote count above zero.";
  section.append(rule);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "None right now. This public cluster also omits vote counts on most amendments, so a real minority vote can be indistinguishable from a parked one until a count is published.";
    section.append(empty);
    return section;
  }
  const stack = document.createElement("div");
  stack.className = "stack";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = isHighlight(item.name) ? "card watch" : "card";
    const row = document.createElement("div");
    row.className = "vote-row";
    const name = document.createElement("h3");
    name.className = "amendment-name";
    name.textContent = item.name;
    const count = document.createElement("p");
    count.className = "vote";
    count.textContent = voteText(item);
    row.append(name, count);
    card.append(row);
    stack.append(card);
  }
  section.append(stack);
  return section;
}

function sectionQuiet(items) {
  const details = document.createElement("details");
  details.className = "panel";
  const summary = document.createElement("summary");
  const headRow = document.createElement("span");
  headRow.className = "section-head";
  const title = document.createElement("h2");
  title.textContent = "Quiet / parked";
  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = `${items.length} not enabled`;
  headRow.append(title, count);
  summary.append(headRow);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "panel-body";
  const rule = document.createElement("p");
  rule.className = "rule";
  rule.textContent = "Known to this server, not enabled, and either showing a zero vote count or no count at all. Enabled amendments are left out of this list.";
  body.append(rule);
  const list = document.createElement("ul");
  list.className = "name-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.name;
    if (isHighlight(item.name) || isKeywordWatch(item.name)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "watch";
      li.append(tag);
    }
    list.append(li);
  }
  body.append(list);
  details.append(body);
  return details;
}

function sectionEnabled(items) {
  const section = document.createElement("section");
  section.append(head("Enabled · name watch", String(items.length)));
  const rule = document.createElement("p");
  rule.className = "rule";
  rule.textContent = "Already enabled. This API does not say when. Shown only when the name matches Batch, Permission, Credentials, or Delegation — not the full enabled set.";
  section.append(rule);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No enabled amendment matched those names.";
    section.append(empty);
    return section;
  }
  const list = document.createElement("ul");
  list.className = "enabled-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.name;
    list.append(li);
  }
  section.append(list);
  return section;
}

function head(titleText, countText) {
  const row = document.createElement("div");
  row.className = "section-head";
  const title = document.createElement("h2");
  title.textContent = titleText;
  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = countText;
  row.append(title, count);
  return row;
}

function fact(label, valueNode) {
  const wrap = document.createDocumentFragment();
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.append(valueNode);
  wrap.append(dt, dd);
  return wrap;
}

function timeBlock(ms) {
  const wrap = document.createElement("div");
  const local = document.createElement("span");
  local.className = "when when-local";
  local.textContent = chicagoFormat.format(new Date(ms));
  const utc = document.createElement("span");
  utc.className = "when when-utc";
  utc.textContent = utcFormat.format(new Date(ms));
  wrap.append(local, utc);
  return wrap;
}

function voteNode(item) {
  const p = document.createElement("p");
  p.className = "vote";
  p.textContent = voteText(item);
  return p;
}

function voteText(item) {
  if (item.count == null && item.threshold == null && item.validations == null) {
    return "Not in this response. count, threshold, and validations show up when a server is scoring UNL validations. This public cluster usually leaves them out.";
  }
  const parts = [];
  if (item.count != null && item.threshold != null) {
    parts.push(`${item.count} / ${item.threshold} threshold`);
  } else if (item.count != null) {
    parts.push(`${item.count} yes votes`);
  }
  if (item.validations != null) parts.push(`${item.validations} validations`);
  return parts.join(" · ");
}

function ledgerCheckNode(item, data) {
  const p = document.createElement("p");
  p.className = "vote";
  if (data.ledgerNote) {
    p.textContent = data.ledgerNote;
    return p;
  }
  const closeTime = data.closeTimes.get(item.id.toUpperCase());
  if (closeTime == null) {
    p.textContent = "No matching CloseTime on the Amendments ledger Majorities list.";
    return p;
  }
  if (closeTime === item.majority) {
    p.textContent = `Matches Amendments ledger CloseTime ${fmt(closeTime)} (Ripple epoch).`;
    return p;
  }
  p.textContent = `Disagreement: feature majority ${fmt(item.majority)}, ledger CloseTime ${fmt(closeTime)}.`;
  return p;
}

function errorBox(error) {
  const box = document.createElement("p");
  box.className = "error";
  const message = error && error.name === "AbortError" ? "The request timed out." : (error && error.message) || "Unknown error";
  box.textContent = `Could not read a public XRPL feature endpoint (${message}). Tried HTTPS on xrplcluster.com and xrpl.ws, then WebSocket on the same hosts.`;
  return box;
}

function paintCountdowns() {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-enable-at]")) {
    const target = Number(node.dataset.enableAt);
    node.textContent = formatRemaining(target - now);
  }
}

function formatRemaining(deltaMs) {
  if (deltaMs <= 0) {
    return "14-day window has elapsed";
  }
  const totalMinutes = Math.floor(deltaMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

function majorityTimes(rippleSeconds) {
  const majorityUnix = rippleSeconds + RIPPLE_TO_UNIX_SEC;
  return {
    majorityMs: majorityUnix * 1000,
    enableMs: (majorityUnix + MAJORITY_WINDOW_SEC) * 1000,
  };
}

function isHighlight(name) {
  return /^(batch|permission|delegation)/i.test(name);
}

function isKeywordWatch(name) {
  return /batch|permission|credential|delegat/i.test(name);
}

function labelEndpoint(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (error) {
    return endpoint;
  }
}

function fmt(value) {
  return Number(value).toLocaleString("en-US");
}
