/* Root to Rise front-door kiosk. Plain JS, no build step, so the iPad only
   ever loads three small files. All the rules live in the Worker; this page
   draws what /api/state says and posts codes to /api/punch. */
(function () {
  "use strict";

  var QUEUE_KEY = "r2r-punch-queue";
  var FAILED_KEY = "r2r-punch-failed";
  var POLL_MS = 30000;
  var PIN_IDLE_MS = 30000;
  var DONE_SECONDS = 6;

  var state = {
    data: null,
    offset: 0,            // server clock minus iPad clock, ms
    online: true,
    view: "names",
    who: null,            // staff member on the code screen
    pin: "",
    busy: false,
    idleTimer: null,
    doneTimer: null,
    loadedAt: Date.now(),
  };

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function now() { return new Date(Date.now() + state.offset); }
  function tz() { return (state.data && state.data.timeZone) || "America/New_York"; }
  function timeLabel(d) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d);
  }
  function initial(name) { return String(name || "?").trim().charAt(0).toUpperCase(); }
  function duration(min) {
    min = Math.max(0, Math.round(min || 0));
    var h = Math.floor(min / 60), m = min % 60;
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  function readList(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
  }
  function writeList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* storage off */ }
  }

  // ------------------------------------------------------------------ clock

  function tick() {
    var d = now();
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz(), hour: "numeric", minute: "2-digit" }).formatToParts(d);
    var hm = "", period = "";
    parts.forEach(function (p) {
      if (p.type === "dayPeriod") period = p.value;
      else if (p.type !== "literal" || p.value === ":") hm += p.value;
    });
    var t = $("clock-time");
    t.textContent = hm;
    t.appendChild(el("small", null, period));
    $("clock-date").textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: tz(), weekday: "long", month: "long", day: "numeric",
    }).format(d);

    // Pick up page updates once a day, early in the morning, when nobody is
    // mid-punch.
    var hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz(), hour: "numeric", hourCycle: "h23" }).format(d));
    if (hour === 4 && Date.now() - state.loadedAt > 2 * 3600000 && state.view === "names") location.reload();
  }

  // ------------------------------------------------------------------ data

  // What the iPad believes about someone right now: the server's answer plus
  // any punches still waiting in the offline queue.
  function isClockedIn(person) {
    var inNow = Boolean(person.clockedInAt);
    readList(QUEUE_KEY).forEach(function (q) {
      if (q.staffId === person.id) inNow = q.predicted === "in";
    });
    return inNow;
  }

  function loadState() {
    return fetch("/api/state", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("state " + res.status);
        return res.json();
      })
      .then(function (data) {
        state.offset = new Date(data.now).getTime() - Date.now();
        state.data = data;
        state.online = true;
        render();
        return flushQueue();
      })
      .catch(function () {
        state.online = false;
        renderNotice();
      });
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderNotice();
    renderNames();
    renderSchedule();
  }

  function renderNotice() {
    var box = $("notice");
    var msgs = [];
    var queued = readList(QUEUE_KEY);
    if (!state.online) {
      msgs.push("The time clock can't reach the internet. Clock in and out as usual; times are saved on this iPad and sent when it's back.");
    } else if (queued.length) {
      msgs.push("Sending " + queued.length + " saved punch" + (queued.length > 1 ? "es" : "") + "…");
    }
    readList(FAILED_KEY).forEach(function (f) {
      msgs.push("Couldn't save " + f.name + "'s clock-" + f.predicted + " at " + timeLabel(new Date(f.at)) + " (" + f.reason + "). Please tell Tay or the director. Tap to dismiss.");
    });
    box.textContent = msgs.join(" ");
    box.hidden = msgs.length === 0;
  }

  function renderNames() {
    var wrap = $("tiles");
    wrap.textContent = "";
    if (!state.data) { wrap.appendChild(el("div", "empty", "Loading…")); return; }
    if (!state.data.staff.length) { wrap.appendChild(el("div", "empty", "No staff yet. Add people in Airtable and tick Active.")); return; }
    state.data.staff.forEach(function (p) {
      var inNow = isClockedIn(p);
      var b = el("button", "tile" + (inNow ? " is-in" : ""));
      b.type = "button";
      b.appendChild(el("span", "avatar", initial(p.name)));
      var text = el("span");
      text.appendChild(el("span", "tile-name", p.name));
      var sub = "Clocked out";
      if (inNow) sub = p.clockedInLabel ? "In since " + p.clockedInLabel : "Clocked in";
      text.appendChild(el("span", "tile-sub", sub));
      b.appendChild(text);
      b.addEventListener("click", function () { openPin(p); });
      wrap.appendChild(b);
    });
  }

  var STATUS_TEXT = { in: "Clocked in", done: "Worked today", missing: "Not clocked in yet", scheduled: "Scheduled" };
  var PHASE_TAG = { now: ["Now", "tag tag-now"], next: ["Up next", "tag tag-next"], later: ["Later", "tag"], done: ["Done", "tag"] };

  function renderSchedule() {
    var wrap = $("shifts");
    wrap.textContent = "";
    if (!state.data) return;
    if (!state.data.shifts.length) { wrap.appendChild(el("div", "empty", "No shifts set up yet.")); return; }
    state.data.shifts.forEach(function (s) {
      var card = el("section", "shift" + (s.phase === "now" ? " is-now" : ""));
      var head = el("div", "shift-head");
      var left = el("div");
      left.appendChild(el("h2", null, s.name));
      left.appendChild(el("div", "shift-time", s.startLabel + " – " + s.endLabel));
      head.appendChild(left);
      var tag = PHASE_TAG[s.phase] || PHASE_TAG.later;
      head.appendChild(el("span", tag[1], tag[0]));
      card.appendChild(head);
      if (!s.people.length) card.appendChild(el("div", "shift-empty", "Nobody scheduled"));
      s.people.forEach(function (p) {
        var row = el("div", "person s-" + p.status);
        row.appendChild(el("span", "avatar", initial(p.name)));
        var t = el("span");
        t.appendChild(el("span", "person-name", p.name));
        var label = p.status === "missing" && s.phase === "done" ? "Didn't clock in" : STATUS_TEXT[p.status] || "";
        t.appendChild(el("span", "person-sub", label));
        row.appendChild(t);
        card.appendChild(row);
      });
      wrap.appendChild(card);
    });
  }

  // ------------------------------------------------------------------ views

  function show(view) {
    state.view = view;
    document.querySelector(".app").classList.remove("is-dark");
    ["names", "schedule", "pin", "done"].forEach(function (v) { $("view-" + v).hidden = v !== view; });
    var topVisible = view === "names" || view === "schedule";
    document.querySelector(".toggle").style.visibility = topVisible ? "visible" : "hidden";
    document.querySelectorAll(".toggle button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
    });
    clearTimeout(state.idleTimer);
    clearInterval(state.doneTimer);
    if (view === "pin") armIdle();
  }

  function armIdle() {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(function () { if (!state.busy) show("names"); }, PIN_IDLE_MS);
  }

  // ------------------------------------------------------------------ code screen

  function openPin(person) {
    state.who = person;
    state.pin = "";
    var action = isClockedIn(person) ? "clock out" : "clock in";
    $("pin-avatar").textContent = initial(person.name);
    $("pin-hello").textContent = "Hi, " + person.name;
    var ask = $("pin-ask");
    ask.textContent = "Enter your 4-digit code to ";
    ask.appendChild(el("strong", null, action));
    ask.appendChild(document.createTextNode("."));
    $("pin-status").textContent = isClockedIn(person)
      ? "Clocked in" + (person.clockedInLabel ? " since " + person.clockedInLabel : "")
      : "Currently clocked out";
    $("pin-error").textContent = person.hasPin ? "" : "You don't have a code yet. Ask Tay or the director to set one.";
    renderDots();
    show("pin");
  }

  function renderDots() {
    var dots = $("pin-dots");
    dots.textContent = "";
    for (var i = 0; i < 4; i++) dots.appendChild(el("i", i < state.pin.length ? "on" : ""));
    dots.setAttribute("aria-label", state.pin.length + " of 4 digits entered");
  }

  function press(key) {
    if (state.busy) return;
    armIdle();
    if (key === "clear") state.pin = "";
    else if (key === "del") state.pin = state.pin.slice(0, -1);
    else if (state.pin.length < 4) state.pin += key;
    $("pin-error").textContent = "";
    renderDots();
    if (state.pin.length === 4) submit();
  }

  function buildKeypad() {
    var pad = $("keypad");
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "del"].forEach(function (k) {
      var b = el("button", "key" + (k === "clear" || k === "del" ? " key-text" : ""));
      b.type = "button";
      if (k === "clear") b.textContent = "Clear";
      else if (k === "del") {
        b.setAttribute("aria-label", "Delete last digit");
        b.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="M17 9l-5 6M12 9l5 6"/></svg>';
      } else b.textContent = k;
      b.addEventListener("click", function () { press(k); });
      pad.appendChild(b);
    });
  }

  function pinError(text, shake) {
    $("pin-error").textContent = text;
    state.pin = "";
    renderDots();
    if (shake) {
      var d = $("pin-dots");
      d.classList.remove("shake");
      void d.offsetWidth;
      d.classList.add("shake");
    }
  }

  function submit() {
    var person = state.who;
    var pin = state.pin;
    var predicted = isClockedIn(person) ? "out" : "in";
    var body = { staffId: person.id, pin: pin, requestId: uuid() };
    state.busy = true;

    fetch("/api/punch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        state.busy = false;
        if (r.status === 200) { showDone(r.data, false); loadState(); return; }
        var e = r.data.error;
        if (e === "wrong_pin") {
          pinError("That code didn't match." + (r.data.attemptsLeft ? " " + r.data.attemptsLeft + " tries left." : ""), true);
        } else if (e === "locked") {
          pinError("Too many tries. Try again after " + r.data.untilLabel + ", or ask Tay or the director.", true);
        } else if (e === "no_pin") {
          pinError("You don't have a code yet. Ask Tay or the director to set one.", true);
        } else if (r.status >= 500) {
          saveOffline(body, person, predicted); // Airtable down: keep it and retry
        } else {
          pinError("Something went wrong. Please try again.", true);
        }
      })
      .catch(function () {
        state.busy = false;
        saveOffline(body, person, predicted); // no connection
      });
  }

  function saveOffline(body, person, predicted) {
    var at = now();
    var q = readList(QUEUE_KEY);
    q.push({ staffId: body.staffId, pin: body.pin, requestId: body.requestId, at: at.toISOString(), name: person.name, predicted: predicted });
    writeList(QUEUE_KEY, q);
    state.online = false;
    showDone({ action: predicted, name: person.name, at: at.toISOString(), atLabel: timeLabel(at) }, true);
  }

  // Send saved punches oldest first. Stop at the first one that can't get
  // through, so they always land in order.
  function flushQueue() {
    var q = readList(QUEUE_KEY);
    if (!q.length) { renderNotice(); return Promise.resolve(); }
    var item = q[0];
    return fetch("/api/punch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId: item.staffId, pin: item.pin, requestId: item.requestId, at: item.at }),
    })
      .then(function (res) {
        if (res.status >= 500) throw new Error("retry later");
        return res.json().catch(function () { return {}; }).then(function (data) {
          var rest = readList(QUEUE_KEY).filter(function (x) { return x.requestId !== item.requestId; });
          writeList(QUEUE_KEY, rest);
          if (res.status !== 200) {
            var reasons = { wrong_pin: "wrong code", locked: "too many wrong codes", no_pin: "no code set", too_old: "saved too long ago" };
            var failed = readList(FAILED_KEY);
            failed.push({ name: item.name, at: item.at, predicted: item.predicted, reason: reasons[data.error] || "error" });
            writeList(FAILED_KEY, failed);
          }
          return loadState();
        });
      })
      .catch(function () { renderNotice(); });
  }

  // ------------------------------------------------------------------ done screen

  function showDone(r, offline) {
    var isIn = r.action === "in";
    var view = $("view-done");
    view.classList.toggle("is-in", isIn);
    $("done-icon").innerHTML = isIn
      ? '<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
      : '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>';
    $("done-title").textContent = isIn ? "You're clocked in, " + r.name : "See you next time, " + r.name;
    $("done-time").textContent = (isIn ? "Clocked in at " : "Clocked out at ") + r.atLabel;

    var stats = $("done-stats");
    stats.textContent = "";
    if (!isIn && !offline && r.todayMinutes !== undefined) {
      [["This shift", duration(r.shiftMinutes), r.shiftStartLabel + " – " + r.atLabel],
       ["Today", duration(r.todayMinutes), "all shifts"],
       ["This week", duration(r.weekMinutes), "so far"]].forEach(function (s) {
        var c = el("div", "stat");
        c.appendChild(el("div", "stat-label", s[0]));
        c.appendChild(el("div", "stat-value", s[1]));
        c.appendChild(el("div", "stat-sub", s[2]));
        stats.appendChild(c);
      });
    }
    $("done-note").textContent = offline
      ? "No internet right now, so this was saved on the iPad. It will be sent automatically when the connection is back."
      : isIn
        ? "Have a great day. Before you leave, tap your name again to clock out."
        : "Times look wrong? Let Tay or the director know so they can fix it.";

    show("done");
    document.querySelector(".app").classList.toggle("is-dark", isIn);
    var left = DONE_SECONDS;
    var count = $("done-count");
    count.textContent = "Going back to the name screen in " + left + " seconds";
    state.doneTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) { show("names"); render(); return; }
      count.textContent = "Going back to the name screen in " + left + " second" + (left === 1 ? "" : "s");
    }, 1000);
  }

  // ------------------------------------------------------------------ start

  document.querySelectorAll("[data-view]").forEach(function (b) {
    b.addEventListener("click", function () { show(b.getAttribute("data-view")); render(); });
  });
  $("pin-back").addEventListener("click", function () { show("names"); });
  $("done-btn").addEventListener("click", function () { show("names"); render(); });
  $("notice").addEventListener("click", function () { writeList(FAILED_KEY, []); renderNotice(); });
  window.addEventListener("online", loadState);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) loadState(); });

  buildKeypad();
  render();
  tick();
  setInterval(tick, 1000);
  loadState();
  setInterval(function () { if (state.view !== "pin") loadState(); }, POLL_MS);
})();
