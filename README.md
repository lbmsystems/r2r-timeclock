# Root to Rise time clock

The front-door iPad where staff tap their name, enter a 4-digit code, and
clock in or out. Everything is stored in the **R2R Time Clock** Airtable base
in the Root to Rise workspace.

```
iPad (public/)  ──►  Cloudflare Worker (src/)  ──►  Airtable "R2R Time Clock"
```

**Live kiosk:** <https://r2r-timeclock.learnbuildmaintain.workers.dev>

**Deploys:** Cloudflare Workers Builds watches the `main` branch of this repo.
Every merge into `main` builds and deploys automatically (about a minute).
Changes are made on a branch and reviewed as a pull request first, so
nothing reaches the iPad until it is merged.

- **`public/`** is the kiosk page: plain HTML, CSS and JS, with no build step.
- **`src/`** is the Worker. It serves that page plus a small API, and it is
  the only thing that talks to Airtable. Codes are checked here and never in
  the browser.

## What it does

- **Tap your name.** Anyone clocked in shows green with "In since 8:58 AM",
  so someone heading out can see they still need to clock out.
- **Enter code.** Clocks you in or out, whichever is next. Five wrong codes in
  a row lock that name for 5 minutes.
- **Schedule.** Today's Morning, Midday and Afternoon shifts, and who is
  clocked in, done for the day, or 15+ minutes late. A week strip of dates,
  arrows, *Today* and *Pick a date* show who is scheduled on any day from two
  weeks back to three months ahead. Other days show the schedule only, not
  who clocked in; that stays in the owners' dashboard. The view returns to
  today after a minute untouched.
- **Clock-out summary.** Time for this shift, today, and this week (Sunday to
  Saturday).
- **Hiccups stay quiet.** Airtable allows about 5 requests a second. The
  Worker retries when it is told to slow down, and the kiosk retries quietly
  too. The warning banner appears only if trouble lasts more than about 20
  seconds.
- **No internet?** Punches are saved on the iPad with the time they happened
  and sent when the connection is back, in order. Anything saved more than 12
  hours earlier is refused and shown on screen to be entered by hand.
- **Forgot to clock out?** A shift still open from an earlier day is left
  alone for you to fix, and shows as **Missing clock-out** in Airtable. The
  next tap starts a fresh shift instead of closing yesterday's at today's
  time.

## Day to day, in Airtable

| To… | Do this |
|---|---|
| Add someone | **Staff** → new row → Name, tick **Active**, and type a code in **New PIN** |
| Set or reset a code | Type 4 digits in **New PIN**. Within about 30 seconds the kiosk scrambles it into **PIN Hash** and clears the cell. Never type a code into PIN Hash. |
| Remove someone | Untick **Active**. Their history stays. |
| Unlock someone early | Clear **Locked Until** |
| Schedule a shift | **Schedule** → new row → Date, Shift, Staff (one row per day and shift; add several people to it) |
| Fix a forgotten clock-out | **Punches** → find the row with Status *Missing clock-out* → fill in **Clock Out**, set Source to *Manual fix*, add your name in **Edited By** and a reason |
| Change shift times | **Shift Types** → edit Start/End (24-hour, e.g. `16:00`) |

The **Hours** column on Punches rounds to whole numbers until its format is
changed: click the column header → *Edit field* → *Formatting* → Precision
`1.00`.

## One-time setup

### 1. Airtable access token

From the **Root to Rise** Airtable account: <https://airtable.com/create/tokens>
→ *Create token*.

- Name: `R2R time clock worker`
- Scopes: `data.records:read`, `data.records:write`
- Access: **only** the *R2R Time Clock* base

Copy the token somewhere safe for the next step. Don't paste it into chat,
email or this repo.

### 2. Cloudflare

The Worker is connected to this repo in the Cloudflare dashboard
(*Workers & Pages → r2r-timeclock → Settings → Builds*): production branch
`main`, no build command, deploy command `npx wrangler deploy`, root
directory `/`. Secrets are added under *Settings → Variables and Secrets*,
each as type **Secret**: `AIRTABLE_TOKEN` and `PIN_PEPPER` (see below).

To deploy by hand from a computer instead (Node 20+):

```bash
npm install
npx wrangler login
npx wrangler secret put AIRTABLE_TOKEN
```

```bash
npx wrangler secret put PIN_PEPPER
```

For `PIN_PEPPER`, paste any long random string, for example the output of
`openssl rand -hex 32`. Keep it safe. **Changing it later makes every code stop
working**, so everyone would need a new one.

```bash
npm run deploy
```

Wrangler prints the kiosk's address, like
`https://r2r-timeclock.<your-subdomain>.workers.dev`. To use your own domain
instead (for example `clock.roottorisemicroschool.com`), add it under the
Worker's *Settings → Domains & Routes* in Cloudflare.

### 3. Codes for everyone

In Airtable **Staff**, type a 4-digit code into **New PIN** for each person,
then open the kiosk once. The codes are scrambled and the cells cleared. Tell
each person their code yourself.

### 4. The iPad

1. Open the kiosk address in **Safari** → Share → **Add to Home Screen**.
2. Open it from the Home Screen icon, so it runs full screen.
3. Settings → Display & Brightness → **Auto-Lock: Never**. Keep it plugged in.
4. Settings → Accessibility → **Guided Access**: turn it on and set a passcode
   that only you and Tay know. Open the kiosk, triple-click the top (or home)
   button, then **Start**. The iPad now stays on the time clock.

The page checks in every 30 seconds and reloads itself once a day around 4 AM
to pick up any updates.

## Development

```bash
npm install
npm test          # time-zone math + the whole clock-in/out flow against a fake Airtable
```

```bash
npm run dev       # local Worker at http://localhost:8787
```

To try the dashboard locally, add `INSECURE_DEV_ADMIN_EMAIL=you@example.com`
to `.dev.vars`. It is honoured only for `localhost`, never on the live site.

`npm run dev` needs a `.dev.vars` file (git-ignored) with
`AIRTABLE_TOKEN=...` and `PIN_PEPPER=...`. Use a different pepper than
production. Locally it reads and writes the real base, so test with a
throwaway staff row.

Table and column IDs live in `src/config.js`. Renaming a table or column in
Airtable is safe. Deleting and recreating one is not.

### Settings

All in `src/config.js`:

| Setting | Now |
|---|---|
| Time zone | `America/New_York` |
| Week starts | Sunday |
| Counted late after | 15 minutes |
| Wrong codes before lockout | 5, for 5 minutes |
| Oldest offline punch accepted | 12 hours |

## Owner dashboard

**<https://r2r-timeclock.learnbuildmaintain.workers.dev/admin/>**, for the
owners only. It has three views:

- **Today:** everyone scheduled or clocked in today, Morning first, then
  Midday, then Afternoon. Who is clocked in and today's hours refresh every
  minute, plus a *Needs attention* list:
  - a shift left open from an earlier day (forgot to clock out). Enter the
    time they left and save;
  - someone still clocked in 30+ minutes after their last shift ended (or
    10+ hours with no shift);
  - someone scheduled who hasn't clocked in 15 minutes into their shift, or
    never came in. **Resolve** offers *They worked: add hours* or **Edit**
    (below).
- **Hours & payroll:** hours per person for this week, last week, the last
  two weeks, this or last month, or any range up to 62 days. Each person's
  shifts can be opened and fixed. **Download CSV** gives a row per shift
  plus totals.
- **Schedule:** a week grid with who worked, who is in now, and who was
  scheduled but didn't clock in. The schedule itself is still edited in
  Airtable.

**Edit: change shift or mark absent.** Use **Resolve → Edit** on an alert,
or **Edit** on someone's row (also before anyone is late). It offers:

- **Change shift:** move them to another shift that day (e.g. Morning →
  Afternoon). The **Schedule** table is updated, because the plan really
  changed, and the change is logged in **Schedule Changes** (from, to, note,
  who changed it, when). Their row then reads "Afternoon · moved from
  Morning", and they are expected at the new start time. One person at a
  time: a trade is two changes.
- **Mark absent:** they aren't working that shift. Pick a reason (*Called
  out sick, No-show, Personal / family, Covered by someone else, Shift
  cancelled, Other*) and an optional note. The **Schedule** table is left
  alone; the absence is its own row in **Absences**. They show as *Absent* on
  Today, crossed out on the week grid, counted under Hours and listed in the
  CSV's *Absences* section. On the kiosk they show only as **Out today**,
  never with the reason. **Undo absent** on their row removes it.

Every fix (a forgotten clock-out, a missed punch) needs a short reason. It
is saved on the punch with *Source: Manual fix*, *Edited By* (the owner's
email) and the time of the change.

### Turning on the login (Cloudflare Access)

The dashboard refuses every request until Access protects it, so nothing is
exposed before this is done. Access is free for up to 50 people.

1. In Cloudflare, open **Zero Trust**. The first time, pick a team name
   (for example `roottorise`) and the **Free** plan.
2. **Access → Applications → Add an application → Self-hosted**:
   - Name: `R2R staff hours`
   - Domain: `r2r-timeclock.learnbuildmaintain.workers.dev`, path: `admin`
     (the kiosk at `/` stays open; only `/admin` asks for a login)
   - Policy: **Allow**, Include → **Emails** → the owners' email addresses
   - Login method: **One-time PIN** (a code sent by email) is the default
3. Open the new application and copy its **Application Audience (AUD) Tag**.
4. In the Worker: **Settings → Variables and Secrets → Add**, each as type
   **Secret**:
   - `ACCESS_TEAM_DOMAIN`: your team domain, e.g. `roottorise.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag from step 3
   - `ADMIN_EMAILS` (optional): the same owner emails, comma-separated, as a
     second lock
   
   Then **Deploy** the new version if Cloudflare asks.
5. Open `/admin/`. Cloudflare asks for your email, sends a code, and then
   shows the dashboard.

The Worker checks Access's signature on every request rather than trusting a
header, so a request that did not come through Access gets nothing.

## Not built yet

- An evening check that emails or texts anyone still clocked in after their
  shift.
