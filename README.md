# Root to Rise time clock

The front-door iPad where staff tap their name, enter a 4-digit code, and
clock in or out. Everything is stored in the **R2R Time Clock** Airtable base
in the Root to Rise workspace.

```
iPad (public/)  ──►  Cloudflare Worker (src/)  ──►  Airtable "R2R Time Clock"
```

- **`public/`** is the kiosk page: plain HTML, CSS and JS, with no build step.
- **`src/`** is the Worker. It serves that page plus a small API, and it is
  the only thing that talks to Airtable. Codes are checked here and never in
  the browser.

## What it does

- **Tap your name.** Anyone clocked in shows green with "In since 8:58 AM",
  so someone heading out can see they still need to clock out.
- **Enter code.** Clocks you in or out, whichever is next. Five wrong codes in
  a row lock that name for 5 minutes.
- **Today's schedule.** Today's Morning, Midday and Afternoon shifts, and who
  is clocked in, done for the day, or 15+ minutes late.
- **Clock-out summary.** Time for this shift, today, and this week (Sunday to
  Saturday).
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

### 2. Cloudflare (Root to Rise's own account)

Sign up for a free account at <https://dash.cloudflare.com/sign-up>, then on a
computer with Node 20+:

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

## Not built yet

- The owner dashboard (today, pay period, schedule, payroll CSV), behind a
  Cloudflare Access login for the owners.
- An evening check that emails or texts anyone still clocked in after their
  shift.
