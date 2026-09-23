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
const belowEl = document.querySelector("#below");
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
  refreshBtn.textContent = "refreshing…";
  try {
    const data = await loadAmendments();
    snapshot = data;
    lastFetchMs = Date.now();
    render(data);
    const when = chicagoFormat.format(new Date(lastFetchMs));
    setStamp([
      "cobblr labs",
      labelEndpoint(data.endpoint),
      data.ledgerIndex ? `ledger ${data.ledgerIndex.toLocaleString("en-US")}` : "ledger unavailable",
      `refreshed ${when}`,
    ]);
  } catch (error) {
    setStamp(["cobblr labs", "last refresh failed"]);
    appEl.replaceChildren(errorBox(error));
    belowEl.replaceChildren();
  } finally {
    refreshing = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "refresh";
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
  const hero = document.createDocumentFragment();

  if (location.protocol === "file:") {
    const note = document.createElement("p");
    note.className = "file-note";
    note.textContent = "Opened as a file. If the cluster blocks this, serve the folder with python3 -m http.server 8080.";
    hero.append(note);
  }

  if (grouped.majority.length === 0) {
    hero.append(emptyHero());
  } else {
    hero.append(heroReceipt(grouped.majority[0], data));
    if (grouped.majority.length > 1) {
      hero.append(alsoBlock(grouped.majority.slice(1), data));
    }
  }

  appEl.replaceChildren(hero);

  const below = document.createDocumentFragment();
  const labeledMath = grouped.majority.length > 1;
  for (const item of grouped.majority) below.append(mathDetails(item, labeledMath));
  below.append(caveats());
  below.append(sectionVoting(grouped.voting));
  below.append(sectionQuiet(grouped.quiet));
  below.append(sectionEnabled(grouped.enabledWatch));
  belowEl.replaceChildren(below);
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

  majority.sort((a, b) => {
    return Number(isHighlight(b.name)) - Number(isHighlight(a.name))
      || a.majority - b.majority
      || a.name.localeCompare(b.name);
  });
  voting.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  quiet.sort((a, b) => a.name.localeCompare(b.name));
  enabledWatch.sort((a, b) => a.name.localeCompare(b.name));
  return { majority, voting, quiet, enabledWatch };
}

function heroReceipt(item, data) {
  const article = document.createElement("article");
  article.className = "receipt";
  article.append(amendmentTitle(item.name, "h2"));
  if (!item.supported) article.append(unsupportedNote());
  article.append(countdownBlock(item));
  article.append(timeFacts(item));
  article.append(checkList(item, data));
  return article;
}

function emptyHero() {
  const article = document.createElement("article");
  article.className = "receipt empty-hero";
  const title = amendmentTitle("Nothing in majority.", "h2");
  const state = document.createElement("p");
  state.className = "state";
  state.textContent = "No amendment is on the 14-day clock.";
  article.append(title, state);
  return article;
}

function alsoBlock(items, data) {
  const section = document.createElement("section");
  section.className = "also";
  const title = document.createElement("h3");
  title.textContent = "also in majority";
  section.append(title);
  for (const item of items) section.append(alsoItem(item, data));
  return section;
}

function alsoItem(item, data) {
  const article = document.createElement("article");
  article.className = "also-item";
  const name = document.createElement("h4");
  name.textContent = item.name;
  article.append(name);
  if (!item.supported) article.append(unsupportedNote());
  const times = majorityTimes(item.majority);
  const count = document.createElement("p");
  count.className = "countdown-small";
  count.dataset.enableAt = String(times.enableMs);
  article.append(count);
  article.append(alsoTime("since", times.majorityMs));
  article.append(alsoTime("enable", times.enableMs));
  if (item.count != null || item.threshold != null || item.validations != null) {
    const votes = document.createElement("p");
    votes.className = "also-meta";
    votes.textContent = `votes ${voteText(item)}`;
    article.append(votes);
  }
  const ledger = ledgerCheck(item, data);
  const note = document.createElement("p");
  note.className = ledger.warn ? "also-meta warn-text" : "also-meta";
  note.textContent = ledger.text;
  article.append(note);
  return article;
}

function alsoTime(label, ms) {
  const line = document.createElement("p");
  line.className = "also-meta";
  line.textContent = `${label} ${chicagoFormat.format(new Date(ms))} · ${utcFormat.format(new Date(ms))}`;
  return line;
}

function amendmentTitle(text, tag) {
  const name = document.createElement(tag);
  name.className = tag === "h2" ? "amendment" : "";
  name.textContent = text;
  return name;
}

function unsupportedNote() {
  const state = document.createElement("p");
  state.className = "state warn-text";
  state.textContent = "This server does not support the code.";
  return state;
}

function countdownBlock(item) {
  const times = majorityTimes(item.majority);
  const wrap = document.createElement("div");
  wrap.className = "countdown-block";
  const count = document.createElement("p");
  count.className = "countdown";
  count.dataset.enableAt = String(times.enableMs);
  const note = document.createElement("p");
  note.className = "hold";
  note.textContent = "if majority holds";
  wrap.append(count, note);
  return wrap;
}

function timeFacts(item) {
  const times = majorityTimes(item.majority);
  const facts = document.createElement("dl");
  facts.className = "facts";
  facts.append(fact("majority since", timeBlock(times.majorityMs)));
  facts.append(fact("estimated enable", timeBlock(times.enableMs)));
  return facts;
}

function checkList(item, data) {
  const checks = document.createElement("ul");
  checks.className = "checks";
  checks.append(check("votes", voteText(item), false));
  const ledger = ledgerCheck(item, data);
  checks.append(check("ledger", ledger.text, ledger.warn));
  return checks;
}

function mathDetails(item, labeled) {
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
  const label = labeled ? `arithmetic · ${item.name}` : "arithmetic";
  return fold(label, pre);
}

function caveats() {
  return fold(
    "caveats",
    paragraph("More than 80% for 14 continuous days, then it can enable. The date is majority time plus 14 × 24 × 3600 seconds. At or below 80% the timestamp is cleared and the clock starts over."),
    paragraph("The network checks on flag ledgers, about every 15 minutes. The second here is not the exact ledger that flips it on."),
    paragraph("Silence is not a yes. Only explicit votes count. count, threshold, and validations show up when a server is scoring UNL validations. This public cluster usually leaves them out. A missing count is not zero."),
    paragraph("The page reads the public feature API about every 60 seconds and checks majority against Amendments ledger CloseTime."),
  );
}

function sectionVoting(items) {
  if (items.length === 0) {
    return fold("voting · 0", paragraph("None with a published count."));
  }
  const list = document.createElement("ul");
  list.className = "ledger-list";
  for (const item of items) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "ledger-name";
    name.textContent = item.name;
    const count = document.createElement("span");
    count.className = "ledger-count";
    count.textContent = voteText(item);
    li.append(name, count);
    list.append(li);
  }
  return fold(`voting · ${items.length}`, list);
}

function sectionQuiet(items) {
  const list = document.createElement("ul");
  list.className = "name-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.name;
    list.append(li);
  }
  return fold(
    `quiet / parked · ${items.length}`,
    paragraph("Known to this server, not enabled, count zero or missing."),
    list,
  );
}

function sectionEnabled(items) {
  const note = paragraph("Already enabled. Batch, Permission, Credentials, or Delegation in the name. No enable time in this API.");
  if (items.length === 0) {
    return fold("enabled · 0", note, paragraph("None of those names are enabled."));
  }
  const list = document.createElement("ul");
  list.className = "name-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.name;
    list.append(li);
  }
  return fold(`enabled · ${items.length}`, note, list);
}

function fold(summaryText, ...nodes) {
  const details = document.createElement("details");
  details.className = "fold";
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const body = document.createElement("div");
  body.className = "fold-body";
  body.append(...nodes);
  details.append(summary, body);
  return details;
}

function paragraph(text) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
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

function voteText(item) {
  if (item.count == null && item.threshold == null && item.validations == null) {
    return "not in this response";
  }
  const parts = [];
  if (item.count != null && item.threshold != null) {
    parts.push(`${item.count} / ${item.threshold} threshold`);
  } else if (item.count != null) {
    parts.push(`${item.count} yes`);
  }
  if (item.validations != null) parts.push(`${item.validations} validations`);
  return parts.join(" · ");
}

function ledgerCheck(item, data) {
  if (data.ledgerNote) return { text: data.ledgerNote, warn: true };
  const closeTime = data.closeTimes.get(item.id.toUpperCase());
  if (closeTime == null) {
    return { text: "No matching CloseTime on the Amendments ledger.", warn: true };
  }
  if (closeTime === item.majority) {
    return { text: `CloseTime ${fmt(closeTime)} matches`, warn: false };
  }
  return {
    text: `Disagreement: feature majority ${fmt(item.majority)}, CloseTime ${fmt(closeTime)}.`,
    warn: true,
  };
}

function check(label, text, warn) {
  const li = document.createElement("li");
  if (warn) li.className = "warn";
  const key = document.createElement("span");
  key.textContent = label;
  li.append(key, document.createTextNode(text));
  return li;
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
    const delta = Number(node.dataset.enableAt) - now;
    node.textContent = formatRemaining(delta);
    node.classList.toggle("elapsed", delta <= 0);
  }
}

function formatRemaining(deltaMs) {
  if (deltaMs <= 0) return "14-day window has elapsed";
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

function setStamp(parts) {
  const fragment = document.createDocumentFragment();
  parts.forEach((part, index) => {
    if (index > 0) fragment.append(document.createTextNode(" · "));
    fragment.append(document.createTextNode(part));
  });
  statusEl.replaceChildren(fragment);
}

function fmt(value) {
  return Number(value).toLocaleString("en-US");
}
