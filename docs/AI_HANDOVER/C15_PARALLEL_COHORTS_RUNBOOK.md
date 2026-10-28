# Running two cohorts side by side — operator runbook (AIAP C15 IST and EST)

Everything below is done from the admin screens. No deployment, environment variable or script is needed to add a cohort or point it at a spreadsheet tab. The Google service account is shared and configured on the server. The C15 tabs live in the newer spreadsheet **Hackathon Group Allocator**, so each C15 cohort names that spreadsheet's ID; historical cohorts (C13, C14) keep reading the default spreadsheet ("Group Allocator - Updated") with no change. The service account must be shared on the new spreadsheet as a viewer.

**The one rule:** the cohort you have selected decides which tab is read, where submissions go, and what is judged, ranked and exported. Time of day and deadlines never decide any of that. Importing never starts judging; only the Start judging button for that cohort does.

## 1. Create C15 IST

1. Admin → **Cohorts** → **+ Create cohort**.
2. Basics: Name `AIAP C15 IST`, Code `C15IST`, Timezone `Asia/Kolkata`.
3. "Where submissions come from": **External Google Sheet intake**. Then:
   - External cohort ID: `AIAP-C15-IST`
   - Spreadsheet ID: the long id from the Hackathon Group Allocator URL (`https://docs.google.com/spreadsheets/d/<ID>/…`); pasting the whole URL also works
   - Google Sheet tab: `Submissions - AIAP C15 IST`
   - Sheet timestamps are in: the spreadsheet's own timezone (for a sheet maintained in India, `Asia/Kolkata`).
4. Schedule: Day 12 start and the 10:00 AM Day 13 deadline in the cohort timezone. Shortlist target 10. Review → Create.
5. The cohort card now shows an **Intake** panel with these values. Press **Test tab (read-only)** — it should report the tab, its row count (0 is fine) and "All expected columns present".
6. Open **Manage cohort → Ideas** and approve the cohort's idea catalogue. Importing refuses until at least one idea is approved.

## 2. Assign or change the IST tab later

Cohorts → the C15 IST card → **Intake** panel → edit the spreadsheet ID, the tab or the timezone → **Save intake settings** → **Test tab**. The external cohort ID is locked once the cohort holds imported submissions; the tab name can still be corrected. A tab or ID already used by another cohort is refused.

## 3. Create C15 EST and assign its tab

Repeat section 1 with Name `AIAP C15 EST`, Code `C15EST`, External cohort ID `AIAP-C15-EST`, the same Spreadsheet ID, tab `Submissions - AIAP C15 EST`, the 8:00 PM deadline, and the sheet's timezone. Both cohorts can be in draft or closed at the same time; neither needs the other to close.

## 4. Check each tab (any time, as often as you like)

Admin → **Google Sheet intake**. Pick the cohort in the **Managing cohort** row — the page shows that cohort's tab, external ID, timezone and approved-idea count. **1. Test connection**, then **2. Check the sheet**. Only that cohort's tab is read; switching cohorts reads and writes nothing. Selecting C15 EST and checking shows only the EST tab.

## 5. Import each cohort

On the same page, with the right cohort selected: after a fresh **Check the sheet**, **3. Import final submissions** → confirm. The import is bound to that cohort and that tab (a check of IST can never authorise an import into EST, and a sheet edited after the check is refused). Imported submissions are queued but **not judged** — the Judging page shows the jobs waiting. Group 12 in both tabs is two different teams in two different cohorts.

## 6. Manually start IST judging

1. Cohorts → C15 IST → Lifecycle → **Mark ready for judging** (draft → closed; a sheet-fed cohort never opens the portal).
2. Admin → **Judging**, select C15 IST → **Start judging**. From that moment the worker may claim IST jobs. EST jobs, if imported, stay queued and untouched.

## 7. Manually start EST judging

Same two steps with C15 EST selected, whenever you decide — before, during or after IST judging. If both are judging, the one worker takes jobs from both queues in turn; nothing about IST changes.

## 8. See separate rankings

Admin → **Shortlist**, choose the cohort in the Managing cohort row → **Generate shortlist**, **Run second pass**, regenerate. Every count, card and button on the page belongs to the selected cohort; the URL carries `?cohort=…`, so a bookmarked link stays on that cohort.

## 9. Export separate CSVs

Shortlist page, cohort selected → **Export results & feedback CSV** and **Export all submissions audit CSV**. Filenames carry the cohort code (`c15ist-…`, `c15est-…`). An IST file never contains an EST product.

## 10. Select separate Top 3 winners

Admin → **Finalists**, cohort selected → three positions from that cohort's current ranking, each with a written reason → **Confirm final selection**. The other cohort's selection is untouched.

## Reusing this for C16

Create C16 IST and C16 EST the same way with their own IDs and tabs. Nothing else changes.
