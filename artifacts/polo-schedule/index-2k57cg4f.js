// schedule.js
var ZONE = "America/Los_Angeles";
var NAMES = { polo: "Polo Field · cycling", kezar: "Kezar · running" };
function parseCSV(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (header !== "venue,date,windows,checked,source,note")
    throw Error("Unexpected CSV header");
  const seen = new Set;
  return lines.filter(Boolean).map((line) => {
    const fields = line.split(",");
    if (fields.length !== 6)
      throw Error("Expected six CSV fields");
    const [venue, date, windows, checked, source, note] = fields;
    if (!NAMES[venue] || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(checked) || !source.startsWith("https://sfrecpark.org/"))
      throw Error("Invalid CSV row");
    const key = `${venue}/${date}`;
    if (seen.has(key))
      throw Error("Duplicate schedule day");
    seen.add(key);
    const intervals = windows ? windows.split(";").map((window) => {
      const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
      if (!match)
        throw Error("Invalid window");
      const [, ah, am, bh, bm] = match.map(Number);
      const start = ah * 60 + am, end = bh * 60 + bm;
      if (ah > 23 || am > 59 || bh > 24 || bm > 59 || bh === 24 && bm !== 0 || start >= end)
        throw Error("Invalid time");
      return { start, end };
    }) : [];
    for (let i = 1;i < intervals.length; i++)
      if (intervals[i].start < intervals[i - 1].end)
        throw Error("Overlapping or unsorted windows");
    return { venue, date, intervals, checked, source, note };
  });
}
function localNow(now = new Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: +parts.hour * 60 + +parts.minute };
}
function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isStale(row, date) {
  return date > addDays(row.checked, 7);
}
function timeLabel(minute) {
  if (minute === 1440)
    return "end of day";
  const hour = Math.floor(minute / 60);
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}
function status(rows, venue, now = new Date) {
  const { date, minute } = localNow(now);
  const row = rows.find((r) => r.venue === venue && r.date === date);
  if (!row || isStale(row, date))
    return { state: "unknown", label: row ? "Stale schedule" : "Unknown", detail: "Check the official schedule." };
  const active = row.intervals.find((w) => minute >= w.start && minute < w.end);
  if (active)
    return { state: "open", label: "Scheduled open", detail: `Until ${timeLabel(active.end)} today.` };
  const next = rows.filter((r) => r.venue === venue && r.date >= date && !isStale(r, date)).sort((a, b) => a.date.localeCompare(b.date)).flatMap((r) => r.intervals.map((w) => ({ ...w, date: r.date }))).find((w) => w.date > date || w.start > minute);
  return { state: "closed", label: "Not scheduled open", detail: next ? `Next listed opening: ${next.date === date ? "today" : next.date} at ${timeLabel(next.start)}.` : "No next opening in saved data." };
}

// schedule.csv
var schedule_default = "./schedule-yytx3vec.csv";

// app.js
var rows = [];
var error = "";
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className)
    node.className = className;
  return node;
}
function render() {
  const now = new Date, { date } = localNow(now);
  document.querySelector("#clock").textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(now);
  document.querySelector("#message").textContent = error;
  const cards = document.querySelector("#now");
  cards.replaceChildren();
  for (const venue of ["polo", "kezar"]) {
    const current = status(rows, venue, now), card = element("article", "");
    card.append(element("h2", NAMES[venue]), element("p", current.label, `status ${current.state}`), element("p", current.detail));
    const row = rows.find((r) => r.venue === venue && r.date === date);
    card.append(element("p", row ? `Source checked ${row.checked}${isStale(row, date) ? " · stale" : ""}` : "No saved data for today", "muted"));
    cards.append(card);
  }
  const body = document.querySelector("#days");
  body.replaceChildren();
  for (let i = 0;i < 7; i++) {
    const day = addDays(date, i), tr = element("tr", "");
    tr.append(element("th", i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))));
    for (const venue of ["polo", "kezar"]) {
      const row = rows.find((r) => r.date === day && r.venue === venue), td = element("td", "");
      if (!row)
        td.append(element("div", "Unknown · needs update"));
      else {
        if (isStale(row, date))
          td.append(element("div", "Stale · verify source", "closed"));
        for (const w of row.intervals)
          td.append(element("div", `${timeLabel(w.start)} – ${timeLabel(w.end)}`));
        if (!row.intervals.length)
          td.append(element("div", "No scheduled open times"));
        if (row.note)
          td.append(element("div", row.note, "muted"));
      }
      tr.append(td);
    }
    body.append(tr);
  }
}
async function load() {
  try {
    const response = await fetch(schedule_default);
    if (!response.ok)
      throw Error(`HTTP ${response.status}`);
    rows = parseCSV(await response.text());
    error = "";
  } catch {
    rows = [];
    error = "Could not load the schedule. Use the official links below.";
  }
  render();
}
async function checkForUpdate() {
  const current = document.querySelector("script[type=module]").getAttribute("src");
  const html = await fetch(location.pathname, { cache: "no-store" }).then((r) => r.text()).catch(() => "");
  if (html && !html.includes(current))
    location.reload();
}
document.querySelector("#csv-link").href = schedule_default;
load();
setInterval(render, 60000);
setInterval(checkForUpdate, 15 * 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden)
    checkForUpdate();
});
