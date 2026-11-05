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
    problem: "",          // a setup or server error, as opposed to no connection
    view: "names",
    who: null,            // staff member on the code screen
    pin: "",
    busy: false,
    idleTimer: null,
    doneTimer: null,
    loadedAt: Date.now(),
    schedDate: null,      // another day shown on the schedule view; null = today
    schedData: null,      // that day's /api/schedule reply
    schedError: "",
    schedTimer: null,
    troubleSince: 0,      // when the current connection trouble started; 0 = none
    problemIsSetup: false,
    retryTimer: null,
  };

  // A hiccup (Airtable busy for a few seconds, Wi-Fi blip) is retried quietly.
  // The warning banner only appears if the trouble lasts longer than this.
  var NOTICE_GRACE_MS = 20000;
  var QUICK_RETRY_MS = 6000;
  var AFTER_PUNCH_REFRESH_MS = 5000;

  var SCHED_IDLE_MS = 60000;   // a future day snaps back to today after this
  var DAYS_BACK = 14, DAYS_AHEAD = 90; // same window the Worker allows

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
  // A round photo if the person has one in Airtable, else their initial. If
  // the photo can't load (offline, say), the initial shows instead.
  function avatar(cls, name, photo) {
    var a = el("span", cls, initial(name));
    if (photo) {
      var img = el("img");
      img.alt = "";
      img.decoding = "async";
      img.src = photo;
      img.addEventListener("error", function () { img.remove(); a.classList.remove("has-photo"); });
      a.classList.add("has-photo");
      a.appendChild(img);
    }
    return a;
  }
  function photoFor(id) {
    var p = state.data && state.data.staff.filter(function (x) { return x.id === id; })[0];
    return p ? p.photo : null;
  }
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
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw { reply: data, status: res.status };
          return data;
        });
      })
      .then(function (data) {
        state.offset = new Date(data.now).getTime() - Date.now();
        state.data = data;
        state.online = true;
        state.problem = "";
        state.problemIsSetup = false;
        state.troubleSince = 0;
        render();
        return flushQueue();
      })
      .catch(function (err) {
        // The Worker answered, but with an error: say what it is, rather
        // than blaming the internet.
        if (err && err.reply) {
          state.online = true;
          state.problem = describeProblem(err.reply, err.status);
          state.problemIsSetup = err.reply.error === "not_configured";
        } else {
          state.online = false;
          state.problem = "";
          state.problemIsSetup = false;
        }
        noteTrouble();
        render();
      });
  }

  // Start (or continue) a spell of trouble: try again soon, and only show the
  // banner if it is still going after NOTICE_GRACE_MS.
  function noteTrouble() {
    if (!state.troubleSince) {
      state.troubleSince = Date.now();
      setTimeout(renderNotice, NOTICE_GRACE_MS + 100);
    }
    if (!state.retryTimer && Date.now() - state.troubleSince < 30000) {
      state.retryTimer = setTimeout(function () { state.retryTimer = null; loadState(); }, QUICK_RETRY_MS);
    }
  }
  function troubleShowing() {
    return state.troubleSince && Date.now() - state.troubleSince >= NOTICE_GRACE_MS;
  }

  function describeProblem(reply, status) {
    if (reply.error === "not_configured") {
      return "The time clock isn't set up yet" +
        (reply.missing && reply.missing.length ? " (missing " + reply.missing.join(" and ") + ")" : "") +
        ". Clock-ins are saved on this iPad until it is. Please tell Tay or the director.";
    }
    if (reply.error === "airtable_unavailable") {
      return "The time clock can't reach Airtable right now. Clock in and out as usual; times are saved on this iPad and sent when it's back.";
    }
    return "The time clock hit a problem (" + (reply.error || "error " + status) + "). Clock-ins are saved on this iPad. Please tell Tay or the director.";
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
    if (state.problem && (state.problemIsSetup || troubleShowing())) {
      msgs.push(state.problem);
    } else if (!state.online && troubleShowing()) {
      msgs.push("The time clock can't reach the internet. Clock in and out as usual; times are saved on this iPad and sent when it's back.");
    } else if (queued.length && troubleShowing()) {
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
    if (!state.data) {
      var waiting = state.problem || !state.online ? "Can't load the staff list. See the message above." : "Loading…";
      wrap.appendChild(el("div", "empty", waiting));
      return;
    }
    if (!state.data.staff.length) { wrap.appendChild(el("div", "empty", "No staff yet. Add people in Airtable and tick Active.")); return; }
    state.data.staff.forEach(function (p) {
      var inNow = isClockedIn(p);
      var b = el("button", "tile" + (inNow ? " is-in" : ""));
      b.type = "button";
      b.appendChild(avatar("avatar", p.name, p.photo));
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

  var STATUS_TEXT = { in: "Clocked in", done: "Worked today", missing: "Not clocked in yet", scheduled: "Scheduled", out: "Out today" };
  var PHASE_TAG = { now: ["Now", "tag tag-now"], next: ["Up next", "tag tag-next"], later: ["Later", "tag"], done: ["Done", "tag"] };

  // ---- dates on the schedule view ("YYYY-MM-DD", calendar math in UTC)

  function todayStr() {
    if (state.data) return state.data.today;
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(now());
  }
  function selectedDate() { return state.schedDate || todayStr(); }
  function parseDay(d) { var p = d.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function addDays(d, n) {
    var t = parseDay(d);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function dayLabel(d, opts) { return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "UTC" }, opts)).format(parseDay(d)); }
  function inRange(d) { var t = todayStr(); return d >= addDays(t, -DAYS_BACK) && d <= addDays(t, DAYS_AHEAD); }

  function selectDate(d) {
    if (!d || !inRange(d)) return;
    clearTimeout(state.schedTimer);
    if (d === todayStr()) {
      state.schedDate = null;
      state.schedData = null;
      state.schedError = "";
      renderSchedule();
      return;
    }
    state.schedDate = d;
    state.schedData = null;
    state.schedError = "";
    renderSchedule();
    state.schedTimer = setTimeout(function () { selectDate(todayStr()); }, SCHED_IDLE_MS);
    fetch("/api/schedule?date=" + encodeURIComponent(d), { cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (data) { if (!res.ok) throw data; return data; });
      })
      .then(function (data) {
        if (state.schedDate !== d) return; // someone already moved on
        state.schedData = data;
        renderSchedule();
      })
      .catch(function () {
        if (state.schedDate !== d) return;
        state.schedError = "Couldn't load that day. Check the connection and try again.";
        renderSchedule();
      });
  }

  function renderDateBar() {
    var sel = selectedDate();
    var today = todayStr();
    var start = addDays(sel, -parseDay(sel).getUTCDay()); // the Sunday of that week
    var chips = $("day-chips");
    chips.textContent = "";
    for (var i = 0; i < 7; i++) {
      (function (d) {
        var b = el("button", "chip" + (d === sel ? " is-sel" : "") + (d === today ? " is-today" : ""));
        b.type = "button";
        b.disabled = !inRange(d);
        b.setAttribute("aria-pressed", String(d === sel));
        b.setAttribute("aria-label", (d === today ? "Today, " : "") + dayLabel(d, { weekday: "long", month: "long", day: "numeric" }));
        b.appendChild(el("span", null, d === today ? "Today" : dayLabel(d, { weekday: "short" })));
        b.appendChild(el("strong", null, dayLabel(d, { day: "numeric" })));
        b.appendChild(el("span", null, dayLabel(d, { month: "short" })));
        b.addEventListener("click", function () { selectDate(d); });
        chips.appendChild(b);
      })(addDays(start, i));
    }
    $("week-prev").disabled = !inRange(addDays(start, -1));
    $("week-next").disabled = !inRange(addDays(start, 7));
    $("day-today").disabled = sel === today;
    var pick = $("day-pick");
    pick.min = addDays(today, -DAYS_BACK);
    pick.max = addDays(today, DAYS_AHEAD);
    pick.value = sel;
  }

  function renderSchedule() {
    renderDateBar();
    var wrap = $("shifts");
    wrap.textContent = "";
    var sel = selectedDate();
    var isToday = sel === todayStr();
    $("schedule-title").textContent = isToday
      ? "Who's working today"
      : "Who's working " + dayLabel(sel, { weekday: "long", month: "long", day: "numeric" });

    if (!isToday) {
      if (state.schedError) { wrap.appendChild(el("div", "empty", state.schedError)); return; }
      if (!state.schedData) { wrap.appendChild(el("div", "empty", "Loading…")); return; }
    }
    var shifts = isToday ? (state.data ? state.data.shifts : null) : state.schedData.shifts;
    if (!shifts) return;
    if (!shifts.length) { wrap.appendChild(el("div", "empty", "No shifts set up yet.")); return; }
    shifts.forEach(function (s) {
      var over = s.phase === "done" || s.phase === "past";
      var card = el("section", "shift" + (s.phase === "now" ? " is-now" : "") + (over ? " is-done" : ""));
      var head = el("div", "shift-head");
      var left = el("div");
      left.appendChild(el("h2", null, s.name));
      left.appendChild(el("div", "shift-time", s.startLabel + " – " + s.endLabel));
      head.appendChild(left);
      var tag = PHASE_TAG[s.phase];
      if (tag) head.appendChild(el("span", tag[1], tag[0]));
      card.appendChild(head);
      if (!s.people.length) card.appendChild(el("div", "shift-empty", "Nobody scheduled"));
      s.people.forEach(function (p) {
        var row = el("div", "person s-" + p.status);
        row.appendChild(avatar("avatar", p.name, photoFor(p.id)));
        var t = el("span");
        t.appendChild(el("span", "person-name", p.name));
        var label = p.status === "missing" && s.phase === "done" ? "Didn't clock in"
          : p.status === "out" && !isToday ? "Out" : STATUS_TEXT[p.status] || "";
        t.appendChild(el("span", "person-sub", label));
        row.appendChild(t);
        card.appendChild(row);
      });
      wrap.appendChild(card);
    });
  }

  // ------------------------------------------------------------------ views

  function show(view) {
    if (view !== "schedule" && state.schedDate) {
      clearTimeout(state.schedTimer);
      state.schedDate = null;
      state.schedData = null;
      state.schedError = "";
    }
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
    var fresh = avatar("avatar avatar-lg", person.name, person.photo);
    fresh.id = "pin-avatar";
    $("pin-avatar").replaceWith(fresh);
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
        if (r.status === 200) {
          // Show the change right away, and refresh from Airtable a little
          // later, so the punch and the refresh don't arrive at Airtable in
          // the same second.
          person.clockedInAt = r.data.action === "in" ? r.data.at : null;
          person.clockedInLabel = r.data.action === "in" ? r.data.atLabel : null;
          showDone(r.data, false);
          setTimeout(loadState, AFTER_PUNCH_REFRESH_MS);
          return;
        }
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
    noteTrouble(); // retried in a few seconds; the banner waits out the grace period
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
      .catch(function () { noteTrouble(); renderNotice(); });
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
      ? "Saved on this iPad. It will finish syncing on its own in a moment, so there's no need to do it again."
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
  $("week-prev").addEventListener("click", function () {
    var sel = selectedDate();
    var d = addDays(sel, -7);
    selectDate(inRange(d) ? d : addDays(todayStr(), -DAYS_BACK));
  });
  $("week-next").addEventListener("click", function () {
    var d = addDays(selectedDate(), 7);
    selectDate(inRange(d) ? d : addDays(todayStr(), DAYS_AHEAD));
  });
  $("day-today").addEventListener("click", function () { selectDate(todayStr()); });
  $("day-pick").addEventListener("change", function (e) { selectDate(e.target.value); });
  $("day-pick").addEventListener("click", function (e) {
    // Desktop browsers only open the calendar from their own icon; iPad
    // opens it from a tap anywhere on the field.
    try { if (e.target.showPicker) e.target.showPicker(); } catch (err) { /* already open */ }
  });
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
