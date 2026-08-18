# Access code operations

How teams get in, and what to do when they cannot.

A team access code is the only credential a learner has. It is shared across the
team on purpose — any member holding it can edit the submission — and it is the
one thing that must work on the evening of Day 13, when several hundred people
try to use it within the same hour.

---

## 1. What an access code is

| Property | Value |
| --- | --- |
| Length | 12 characters |
| Alphabet | `ABCDEFGHJKMNPQRSTVWXYZ23456789` — no O, 0, I, 1, L or U |
| Shown as | `ABCD-EFGH-JKMN` |
| Stored as | Argon2id hash, nothing else |
| Scope | One live code per team |
| Versioned | Yes — regenerating increments the version |

The alphabet omits the characters people misread when a code is read aloud
across a room or copied off a printed sheet. A team that types `O` instead of
`Q` gets a clean failure rather than a confusing one.

**Codes are never retrievable.** There is no column that could hold plaintext,
no admin screen that shows one, and no support path that recovers one. The
plaintext exists for a single round trip — generated, written into the CSV the
operator downloads, then gone. "Resend their code" is not an operation; "issue
them a new one" is.

That is a deliberate trade. An operator who loses the sheet regenerates for the
affected teams, which is a minor inconvenience. A system that could reprint any
team's credential on demand is a much larger problem, and it is the kind that
only becomes visible after it has been used.

---

## 2. Issuing codes

**Admin → Cohorts → Teams and access.**

Import teams first. A code is issued against a team, so a team that does not
exist cannot have one.

### Download the sheet

`Issue new codes and download` regenerates a code for **every** team in the
cohort and downloads a CSV containing:

| Column | Notes |
| --- | --- |
| Group Number | What the learner types |
| Team Lead | So the operator can address the message |
| Lead Email | Distribution is through Outskill's own channel |
| Access Code | Formatted, readable aloud |
| Submission URL | The same for every team |

Press this **once**. Because generation is the only moment plaintext exists,
downloading it again issues fresh codes and silently invalidates every code you
have already sent out. The panel says so above the button.

### Issue codes for teams imported later

`Issue missing codes` covers only teams without a live code, so nobody who
already has one is disturbed. Use this when a team is added after the main
distribution.

Ticking **Replace existing codes too** regenerates for everyone and signs out
everyone currently editing. It exists for the case where a sheet has leaked.

---

## 3. Distributing codes

The platform sends no email (ADR-024). Distribution is Outskill's own channel —
whatever you already use to reach teams.

Every team needs two things: their code, and the submission URL. A team with the
code but not the address has nothing.

**The submission URL goes into Circle by hand.** There is no Circle integration,
no iframe, no API, and there should never be one. The URL is a plain link; paste
it wherever teams will look for it.

---

## 4. What the teams table shows

| Column | What it tells you |
| --- | --- |
| Access code | `live`, `locked out`, `revoked`, or `none` |
| — version | Shown when a code has been regenerated (`v2`, `v3`) |
| — activity | How many members are editing right now, or when the code was last used |

It never shows a code. If you find one on this page, that is a bug worth
reporting immediately.

The three summary figures at the top of the panel answer the question an
operator actually has on the day:

- **Teams with a live code** — how many can get in at all.
- **Waiting for a code** — who to chase before the window opens.
- **Editing right now** — whether anything is actually happening.

---

## 5. When a team cannot get in

### They locked themselves out

Eight wrong attempts within fifteen minutes locks that team out for fifteen
minutes. On deadline evening those are fifteen minutes they do not have.

**Admin → Cohorts → Teams and access → Clear a lockout.** Enter the group
number, press the button, and they can try again immediately. The panel lists
any team currently locked out, so you usually do not need to be told which.

Rate limiting is keyed on hashed IP **and** group number together. One hostile
client cannot lock out a legitimate team, and one team fumbling its code cannot
lock out a whole office behind a shared connection.

### They never received the code

Issue a new one for that team and send it directly. Do not try to recover the
old one — you cannot.

### They are typing the code but it will not verify

Ask them to read it back. The usual causes, in the order they actually happen:

1. They are on the wrong group number. Check the number against your roster.
2. They copied a trailing space or a line break out of a chat message. Harmless
   — the form strips whitespace and hyphens — but worth ruling out.
3. They read `O` for `Q`, `1` for `J`, or `0` for `D`. None of those characters
   are in the alphabet, so the code will be one character short. Read it back
   character by character.
4. Their code was revoked or regenerated after it was sent. Check the version
   column; anything above `v1` means a newer sheet exists.

The form gives the same message for every failure — a wrong code, an unknown
group, a revoked code and a withdrawn team are indistinguishable from outside.
That is deliberate: a form that said "no such group" would let anyone enumerate
which group numbers exist. It means the operator, not the form, has to work out
which of the four it was.

### The whole cohort cannot get in

Check that codes have been issued at all (the "Waiting for a code" figure), then
check the cohort's window state on **Admin → Cohorts**. A closed or paused
cohort tells learners so on the entry page before they type anything.

---

## 6. Revoking a code

**Teams and access → Revoke code**, on the team's row.

Revoking signs out every member editing under that code immediately, and the
team cannot get back in until a new code is issued. Use it when a code has been
shared outside the team, or when a team withdraws.

Revocation is per team. To invalidate everything at once, regenerate for the
whole cohort instead.

---

## 7. How sessions relate to codes

A code is exchanged for a session once, at sign-in. After that the code never
travels again — not in a URL, not in a request, not in a log.

Each session records the code version it was minted under. Regenerating a team's
code increments that version, which invalidates every session issued under the
old one without anyone having to find them. This is why "regenerate" and "sign
everyone out" are the same operation.

A session lasts until the end of the submission window plus a day, so a team can
still reach their receipt after closing. It is capped at fourteen days, and it
always lasts at least an hour — a team that signs in two minutes before the
deadline still gets a working session.

---

## 8. What is written down

Every access-code action is audit-logged: issued, regenerated, exported,
revoked, lockout cleared. The log records counts and group numbers.

It never records a code. Neither does an error message, an analytics event, or
anything the browser stores.

---

## 9. Quick reference

| Situation | Action |
| --- | --- |
| Setting up a cohort | Import teams → Issue new codes and download → distribute |
| Team imported late | Issue missing codes |
| Team locked out | Clear a lockout |
| Code leaked to one team | Revoke code, then Issue missing codes |
| Sheet leaked | Replace existing codes too, redistribute everything |
| Team lost their code | Revoke code, then Issue missing codes |
| Team says the code does not work | Read it back; check version; check window state |
