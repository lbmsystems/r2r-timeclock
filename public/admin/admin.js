/* Root to Rise owners' dashboard. Plain JS, no build step. Everything it
   shows comes from /admin/api/*, which only answers requests that came
   through Cloudflare Access. */
(function () {
  "use strict";

  var TZ = "America/New_York";
  var REFRESH_MS = 60000;
  var $ = function (id) { return document.getElementById(id); };
  var state = { tab: "", overview: null, hours: null, range: null, preset: "lastweek", weekStart: "", staff: [] };

  // ------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function append(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function duration(min) {
    min = Math.max(0, Math.round(min || 0));
    var h = Math.floor(min / 60), m = min % 60;
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }
  function initial(name) { return String(name || "?").trim().charAt(0).toUpperCase(); }
  function todayLocal() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); }
  function parseDay(d) { var p = d.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function addDays(d, n) { var t = parseDay(d); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function dayLabel(d, opts) { return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "UTC" }, opts)).format(parseDay(d)); }
  function weekStart(d) { return addDays(d, -parseDay(d).getUTCDay()); }

  var ERRORS = {
    dashboard_not_protected: "The dashboard is locked until Cloudflare Access is set up (see the README, \"Owner dashboard\").",
    not_signed_in: "Your sign-in has expired. Reload the page to sign in again.",
    not_an_owner: "This account isn't on the owners' list.",
    airtable_unavailable: "Airtable didn't answer. Try again in a moment.",
    not_configured: "The time clock is missing its Airtable token.",
    reason_required: "Add a short reason. It's saved with the change.",
    out_before_in: "Clock-out has to be after clock-in.",
    out_future: "Clock-out can't be in the future.",
    in_future: "Clock-in can't be in the future.",
    too_long: "That's longer than 16 hours. Check the dates.",
    bad_time: "Fill in a complete date and time.",
    bad_range: "The start date has to be before the end date.",
    range_too_long: "Pick a range of 62 days or less.",
    unknown_staff: "That person isn't in Airtable any more.",
  };
  function message(err) { return ERRORS[err && err.error] || "Something went wrong (" + ((err && err.error) || "error") + ")."; }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || "GET", headers: {}, credentials: "same-origin", cache: "no-store" };
    if (options.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
    return fetch("/admin/api" + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          data.status = res.status;
          if (res.status === 401 || res.status === 403 || res.status === 503) showBanner(message(data));
          throw data;
        }
        hideBanner();
        return data;
      });
    }, function () {
      var err = { error: "network" };
      showBanner("Can't reach the time clock. Check the connection.");
      throw err;
    });
  }
  function showBanner(text) { $("banner").textContent = text; $("banner").hidden = false; }
  function hideBanner() { $("banner").hidden = true; }

  // ---------------------------------------------------------------- tabs

  function route() {
    var tab = (location.hash || "#today").slice(1);
    if (["today", "hours", "schedule"].indexOf(tab) < 0) tab = "today";
    state.tab = tab;
    document.querySelectorAll(".nav a").forEach(function (a) {
      if (a.getAttribute("data-tab") === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    ["today", "hours", "schedule"].forEach(function (t) { $("view-" + t).hidden = t !== tab; });
    if (tab === "today") loadOverview();
    if (tab === "hours") loadHours();
    if (tab === "schedule") loadWeek();
  }

  // --------------------------------------------------------------- today

  function loadOverview() {
    return api("/overview").then(function (o) {
      state.overview = o;
      state.staff = o.staff;
      $("me").textContent = "Signed in as " + o.me;
      $("airtable-link").href = o.airtableUrl;
      renderOverview();
    }).catch(function () {});
  }

  function stat(label, value, alert) {
    var s = el("div", "stat" + (alert ? " is-alert" : ""));
    return append(s, el("div", "stat-label", label), el("div", "stat-value", value));
  }

  function renderOverview() {
    var o = state.overview;
    $("today-date").textContent = o.todayLabel;
    $("today-updated").textContent = "Updated " + o.timeLabel;
    var stats = $("today-stats");
    stats.textContent = "";
    append(stats,
      stat("Clocked in now", String(o.stats.inNow)),
      stat("Hours so far today", duration(o.stats.minutesToday)),
      stat("Needs attention", String(o.stats.needsAttention), o.stats.needsAttention > 0));
    var badge = $("nav-badge");
    badge.textContent = String(o.stats.needsAttention);
    badge.hidden = !o.stats.needsAttention;

    var box = $("attention");
    box.textContent = "";
    $("attention-card").hidden = !o.attention.length;
    o.attention.forEach(function (a) { box.appendChild(renderAlert(a)); });

    var t = $("people-table");
    t.textContent = "";
    var head = append(el("tr"), el("th", null, "Staff"), el("th", null, "Scheduled"), el("th", null, "Status"),
      el("th", null, "In"), el("th", null, "Out"), el("th", "num", "Hours"), el("th"));
    append(t, append(el("thead"), head));
    var body = el("tbody");
    if (!o.people.length) {
      var r = el("tr"), c = el("td", "empty", "Nobody scheduled or clocked in today.");
      c.colSpan = 7;
      append(body, append(r, c));
    }
    var STATUS = { in: ["Clocked in", "pill pill-in"], done: ["Done for the day", "pill"], late: ["Not in yet", "pill pill-late"],
      no_show: ["Didn't come in", "pill pill-late"], scheduled: ["Scheduled", "pill"], off: ["Not scheduled", "pill"] };
    o.people.forEach(function (p) {
      var st = STATUS[p.status] || STATUS.off;
      var row = el("tr");
      var who = append(el("div", "who"), el("span", "avatar", initial(p.name)), el("span", null, p.name));
      var more = el("button", "link-btn", p.punches.length ? "Times" : "");
      more.type = "button";
      append(row, append(el("td"), who), el("td", null, p.shifts.join(", ") || "—"), append(el("td"), el("span", st[1], st[0])),
        el("td", null, p.firstIn || "—"), el("td", null, p.lastOut || (p.status === "in" ? "…" : "—")),
        el("td", "num", p.minutes ? duration(p.minutes) : "—"), append(el("td", "num"), p.punches.length ? more : null));
      body.appendChild(row);
      if (p.punches.length) {
        var detail = el("tr", "detail");
        detail.hidden = true;
        var cell = el("td");
        cell.colSpan = 7;
        cell.appendChild(punchList(p.punches, p.name));
        append(detail, cell);
        body.appendChild(detail);
        more.addEventListener("click", function () { detail.hidden = !detail.hidden; });
      }
    });
    t.appendChild(body);
  }

  function renderAlert(a) {
    var row = el("div", "alert");
    var text = append(el("div", "alert-text"), el("strong", null, a.text));
    if (a.punch) text.appendChild(el("div", "alert-sub", "Clocked in " + (a.dayLabel ? a.dayLabel + " " : "") + "at " + a.punch.inLabel));
    row.appendChild(text);

    if (a.type === "missing_out" || a.type === "over_shift") {
      var form = el("form", "alert-form");
      var label = el("label", null, "Out at ");
      var when = el("input");
      when.type = "datetime-local";
      when.required = true;
      when.min = a.punch.inLocal;
      when.setAttribute("aria-label", "Clocked out at");
      label.appendChild(when);
      var reason = el("input");
      reason.type = "text";
      reason.required = true;
      reason.value = "Forgot to clock out";
      reason.setAttribute("aria-label", "Reason");
      var save = el("button", "btn btn-dark btn-small", "Save");
      save.type = "submit";
      var err = el("div", "form-error");
      append(form, label, reason, save, err);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        save.disabled = true;
        api("/punches/" + a.punch.id, { method: "PATCH", body: { clockOut: when.value, reason: reason.value } })
          .then(loadOverview)
          .catch(function (x) { err.textContent = message(x); save.disabled = false; });
      });
      row.appendChild(form);
    } else {
      var add = el("button", "btn btn-small", "They worked? Add hours");
      add.type = "button";
      add.addEventListener("click", function () { openAdd(a.staffId); });
      row.appendChild(add);
    }
    return row;
  }

  function punchList(punches, name) {
    var table = el("table", "punches");
    punches.forEach(function (p) {
      var r = el("tr");
      var pills = el("div", "pills");
      if (p.open && p.date !== (state.overview && state.overview.today)) pills.appendChild(el("span", "pill pill-late", "Missing clock-out"));
      else if (p.open) pills.appendChild(el("span", "pill pill-in", "In progress"));
      if (p.source === "Manual fix") pills.appendChild(el("span", "pill pill-edit", "Edited" + (p.editedBy ? " by " + p.editedBy.split("@")[0] : "")));
      var edit = el("button", "link-btn", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openEdit(p, name); });
      append(r,
        el("td", null, dayLabel(p.date, { weekday: "short", month: "short", day: "numeric" })),
        el("td", null, p.inLabel + " – " + (p.open ? "…" : p.outLabel)),
        el("td", null, p.open ? "" : duration(p.minutes)),
        append(el("td"), pills),
        el("td", "muted", p.note || ""),
        append(el("td", "num"), edit));
      table.appendChild(r);
    });
    return table;
  }

  // --------------------------------------------------------------- hours

  var PRESETS = [
    ["thisweek", "This week"], ["lastweek", "Last week"], ["last2", "Last 2 weeks"],
    ["thismonth", "This month"], ["lastmonth", "Last month"],
  ];
  function presetRange(key) {
    var t = todayLocal(), ws = weekStart(t);
    if (key === "thisweek") return [ws, t];
    if (key === "lastweek") return [addDays(ws, -7), addDays(ws, -1)];
    if (key === "last2") return [addDays(ws, -14), addDays(ws, -1)];
    var first = t.slice(0, 8) + "01";
    if (key === "thismonth") return [first, t];
    var prevLast = addDays(first, -1);
    return [prevLast.slice(0, 8) + "01", prevLast];
  }

  function renderPresets() {
    var box = $("presets");
    box.textContent = "";
    PRESETS.forEach(function (p) {
      var b = el("button", null, p[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(state.preset === p[0]));
      b.addEventListener("click", function () {
        state.preset = p[0];
        state.range = presetRange(p[0]);
        loadHours();
      });
      box.appendChild(b);
    });
  }

  function loadHours() {
    if (!state.range) state.range = presetRange(state.preset);
    renderPresets();
    $("from").value = state.range[0];
    $("to").value = state.range[1];
    var q = "?from=" + state.range[0] + "&to=" + state.range[1];
    $("csv-link").href = "/admin/api/hours.csv" + q;
    return api("/hours" + q).then(function (h) {
      state.hours = h;
      renderHours();
    }).catch(function (e) {
      if (e && e.status === 400) showBanner(message(e));
    });
  }

  function renderHours() {
    var h = state.hours;
    $("hours-title").textContent = h.label;
    var stats = $("hours-stats");
    stats.textContent = "";
    append(stats,
      stat("Total hours", duration(h.totals.minutes)),
      stat("Shifts", String(h.totals.shifts)),
      stat("Missing clock-outs", String(h.totals.missing), h.totals.missing > 0));

    var t = $("hours-table");
    t.textContent = "";
    append(t, append(el("thead"), append(el("tr"), el("th", null, "Staff"), el("th", "num", "Days"), el("th", "num", "Shifts"),
      el("th", "num", "Hours"), el("th", null, "Check"), el("th"))));
    var body = el("tbody");
    h.people.forEach(function (p) {
      var row = el("tr");
      var check = el("div", "pills");
      if (p.missing) check.appendChild(el("span", "pill pill-late", p.missing + " missing clock-out" + (p.missing > 1 ? "s" : "")));
      if (p.inProgress) check.appendChild(el("span", "pill pill-in", "Clocked in now"));
      if (p.edited) check.appendChild(el("span", "pill pill-edit", p.edited + " edited"));
      if (!p.missing && !p.inProgress && p.shifts) check.appendChild(el("span", "pill", "Ready"));
      var more = el("button", "link-btn", p.shifts ? "Shifts" : "");
      more.type = "button";
      append(row,
        append(el("td"), append(el("div", "who"), el("span", "avatar", initial(p.name)), el("span", null, p.name))),
        el("td", "num", String(p.days)), el("td", "num", String(p.shifts)),
        append(el("td", "num"), el("strong", null, duration(p.minutes))),
        append(el("td"), check), append(el("td", "num"), p.shifts ? more : null));
      body.appendChild(row);
      if (p.shifts) {
        var detail = el("tr", "detail");
        detail.hidden = true;
        var cell = el("td");
        cell.colSpan = 6;
        cell.appendChild(punchList(p.punches, p.name));
        append(detail, cell);
        body.appendChild(detail);
        more.addEventListener("click", function () { detail.hidden = !detail.hidden; });
      }
    });
    t.appendChild(body);
  }

  // ------------------------------------------------------------ schedule

  function loadWeek() {
    var q = state.weekStart ? "?start=" + state.weekStart : "";
    return api("/week" + q).then(function (w) {
      state.weekStart = w.start;
      $("week-label").textContent = w.label;
      $("schedule-edit").href = w.airtableUrl;
      renderWeek(w);
    }).catch(function () {});
  }

  function renderWeek(w) {
    var g = $("week-grid");
    g.textContent = "";
    g.appendChild(el("div", "gh"));
    w.days.forEach(function (d) {
      append(g, append(el("div", "gh" + (d.isToday ? " today" : "")), el("div", "gh-dow", d.isToday ? "Today" : d.dow), el("div", "gh-day", d.day)));
    });
    w.shifts.forEach(function (s) {
      append(g, append(el("div"), el("div", "gs-name", s.name), el("div", "gs-time", s.startLabel + " – " + s.endLabel)));
      s.cells.forEach(function (c) {
        var cell = el("div");
        if (!c.people.length) cell.appendChild(el("div", "empty-cell", "—"));
        c.people.forEach(function (p) {
          var chip = el("div", "chip");
          var dot = el("i", "dot dot-" + p.status);
          dot.setAttribute("aria-hidden", "true");
          append(chip, dot, el("span", null, p.name));
          chip.title = { worked: "Worked", in: "Clocked in now", missed: "Didn't clock in", scheduled: "Scheduled" }[p.status] || "";
          cell.appendChild(chip);
        });
        g.appendChild(cell);
      });
    });
  }

  // ------------------------------------------------------- punch dialog

  var dialogState = null;
  function openEdit(p, name) {
    dialogState = { mode: "edit", punch: p };
    $("punch-title").textContent = "Fix " + name + "'s times";
    $("staff-row").hidden = true;
    $("punch-staff").required = false;
    $("punch-in").value = p.inLocal;
    $("punch-out").value = p.outLocal;
    $("punch-reason").value = "";
    $("punch-error").textContent = "";
    $("punch-dialog").showModal();
  }
  function openAdd(staffId) {
    dialogState = { mode: "add" };
    $("punch-title").textContent = "Add a missed punch";
    $("staff-row").hidden = false;
    $("punch-staff").required = true;
    var sel = $("punch-staff");
    sel.textContent = "";
    var blank = el("option", null, "Choose…");
    blank.value = "";
    sel.appendChild(blank);
    state.staff.forEach(function (s) {
      var o = el("option", null, s.name);
      o.value = s.id;
      sel.appendChild(o);
    });
    sel.value = staffId || "";
    var t = (state.overview && state.overview.today) || todayLocal();
    $("punch-in").value = t + "T";
    $("punch-out").value = "";
    $("punch-reason").value = "";
    $("punch-error").textContent = "";
    $("punch-dialog").showModal();
  }

  $("punch-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = { clockIn: $("punch-in").value, reason: $("punch-reason").value };
    if ($("punch-out").value) body.clockOut = $("punch-out").value;
    var req = dialogState.mode === "edit"
      ? api("/punches/" + dialogState.punch.id, { method: "PATCH", body: body })
      : api("/punches", { method: "POST", body: Object.assign({ staffId: $("punch-staff").value }, body) });
    $("punch-save").disabled = true;
    req.then(function () {
      $("punch-dialog").close();
      route();
    }).catch(function (x) {
      $("punch-error").textContent = message(x);
    }).then(function () { $("punch-save").disabled = false; });
  });
  $("punch-cancel").addEventListener("click", function () { $("punch-dialog").close(); });

  // --------------------------------------------------------------- start

  $("add-punch").addEventListener("click", function () { openAdd(""); });
  $("from").addEventListener("change", function () { state.preset = ""; state.range = [$("from").value, state.range[1]]; loadHours(); });
  $("to").addEventListener("change", function () { state.preset = ""; state.range = [state.range[0], $("to").value]; loadHours(); });
  $("week-prev").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, -7); loadWeek(); });
  $("week-next").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, 7); loadWeek(); });
  $("week-this").addEventListener("click", function () { state.weekStart = ""; loadWeek(); });
  window.addEventListener("hashchange", route);

  // Keep "Today" live: alerts appear as shifts end, without a reload. Skip
  // a refresh while someone is typing a fix.
  setInterval(function () {
    if (state.tab !== "today" || $("punch-dialog").open) return;
    var a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "SELECT")) return;
    loadOverview();
  }, REFRESH_MS);

  route();
  // Other tabs still need the staff list (for "Add a missed punch") and the
  // signed-in name.
  if (state.tab !== "today") {
    api("/overview").then(function (o) {
      state.staff = o.staff;
      $("me").textContent = "Signed in as " + o.me;
      $("airtable-link").href = o.airtableUrl;
    }).catch(function () {});
  }
})();
