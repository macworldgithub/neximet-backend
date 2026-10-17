# Attendance fixes

## Active payroll policy (October 2026)

The following rules supersede the older percentage/fixed/repeat tiers for new attendance:

- Every second late arrival in a calendar month deducts one daily wage. First, third, fifth, etc. late arrivals have no separate charge. Existing shift start and grace settings still define when lateness starts.
- Arrival strictly after 14:00 in Asia/Karachi is a full-day absence with one daily wage deducted; it does not increment the late-pair count. Exactly 14:00 remains in the late window.
- Daily wage is monthly base salary divided by 22, rounded to two decimal places. Manual daily-wage overrides are rejected. Saturday and Sunday are off; approved leave and mandatory holiday exemptions still apply.
- Previously recorded financial evidence retains its saved policy/wage. New records use `late_pairs_v1`; late pairs reset by calendar month and exclude legacy records, simulations and quarantined evidence. Attendance corrections and approved leave reconcile later pairs transactionally.
- Only the CEO receives salary, daily-wage or deduction amounts from login and authenticated APIs, including populated users and audit snapshots. Other roles retain attendance status access. Only CEOs can set pay, assign the CEO role, modify CEO accounts or reset CEO passwords.
- CEO recovery requires a configured private `CEO_MASTER_KEY`; the built-in recovery fallback has been removed.

Validation: `npm run test:attendance` in backend; `npm run test:attendance` and `npm run test:payroll:ui` in frontend. Browser tests use the installed Playwright Chromium, or the executable supplied through `AI_TEST_BROWSER`.

The notes below describe the previous implementation and other attendance fixes.

Attendance calculations now use Asia/Karachi and the configured shift. Overnight attendance belongs to the shift's start date, including overrides, simulations and default payroll-month selection.

Implemented corrections:

- Normal employees use server check-in time and cannot submit CEO simulation or geofence bypass flags.
- Device identification is required when enabled. A partial unique device/day index protects concurrent check-ins without requiring legacy records to have new lock keys.
- Selfies must be bounded JPEG/PNG image data. The check-in JSON limit accommodates valid camera snapshots, and the frontend scales captures before uploading.
- GPS coordinates are checked for type, bounds and office distance. The frontend obtains a fresh location at submission, and disabled verification or simulations are not stamped as verified GPS.
- User/day uniqueness and versioned updates protect check-in/admin races. Check-out is atomic, cannot be overwritten, and cannot produce negative hours.
- Open shifts use the scheduled end captured at check-in. Overdue shifts are finalized on the next attendance/dashboard request at that scheduled time. No continuously running Vercel timer is assumed. Legacy open shifts without a schedule use the current policy.
- The full-day absence threshold is enforced. The third monthly late incident now triggers a threshold of three, and repeat/fixed deductions are capped at one daily wage.
- Zero or unconfigured wages never become an invented PKR 4,000 wage. Policy inputs and threshold ordering are validated.
- Administrators preserve original check-in/out timestamps, work hours, photos and location evidence when marking absent. Employees cannot undo an admin absence. Restoration retains the original status/deductions, and changes keep actor, reason and prior financial values in the audit trail.
- Manual presence has no fabricated arrival timestamp. Super Admins have the same attendance override controls as their API permissions. Explicit working dates prevent midnight rollover from changing the wrong record.
- History filters run before pagination. Totals cover the entire matching query, while personal history remains scoped to the signed-in user.
- CEO and Super Admin company history includes All Time, Today, This Week (Monday-Sunday), This Month and inclusive custom start/end date filters. Case-insensitive employee-name search runs before pagination and combines with date/department/user filters. Search text is treated literally; ordinary employees still cannot access another employee's history. Company-history controls fit at 320, 768 and 1440 pixels, with horizontal scrolling confined to the table.
- History/roster responses contain photo indicators rather than every full-size selfie. Photos have a private owner/executive endpoint and no-store responses.
- Approved full-day leave and mandatory holidays appear distinctly in the roster/dashboard. Working on those exempt days does not receive a late penalty. The company calendar defaults to Monday–Friday, as confirmed by the user, and can be configured in Deduction Rules.
- Company staff counters use the same active employee population and exclude CEO test attendance. Full-day late absence does not also count as present attendance.
- Employee dashboards no longer show squad/team attendance lists or department attendance counters. Managers see their own attendance summary, and personal tasks use the full available width. The dashboard API no longer returns squad attendance data. The removed squad card contained a hardcoded 09:30-18:00 shift label; the actual policy defaults to 09:00-18:00 and follows saved Deduction Rules settings.
- Monthly payroll excludes simulations, distinguishes absence from lateness and restricts Project Managers to their departments. Super Admin ledger access now works.
- The deductions simulator uses the backend calculation instead of a separate frontend formula. CEO arrival simulations are relative to the configured shift and current working day.
- Settings reads no longer create duplicate default policies. Concurrent/stale policy edits cannot silently overwrite a saved configuration. Policy editing is disabled until the saved policy loads successfully, with a reload control for recovery.
- The frontend has consistent company-time clocks, live leave balances, history pagination, explicit clock-out and admin confirmation controls, request timeouts and visible errors. Camera streams are stopped on cancellation, retake and unmount, including streams resolving after a modal closes.
- Malformed legacy dates, check-in timestamps and shift ends are quarantined during automatic shift closure. They do not block subsequent attendance, and their evidence is retained. CEO/Super Admin history provides an audited working-date repair; genuine conflicting records are retained for review.

Additional audit fixes completed on 14 October 2026:

- Leave duration is calculated on the server from the company working-day calendar and mandatory holidays. The form displays that result; conflicting submitted totals are rejected. Morning and afternoon half-day requests cover one working date, adjust the expected half shift and cap its attendance penalty at half the daily wage.
- Pending-only leave review, balance deductions, overlap checks and attendance reconciliation run in one MongoDB transaction. A conditional balance update prevents concurrent overdraw, and a shared employee version serializes leave approval against check-in. Repeated approvals return a conflict without charging twice.
- Approved leave reconciles already-recorded penalties and approved administrator absences, preserving the earlier financial values, schedule and override in the audit trail. It never increases an existing charge. Administrator presence waivers remain waived.
- Sharp fully decodes bounded JPEG/PNG selfies instead of trusting image headers. Truncated/corrupt compressed image data is rejected before attendance is saved.
- The personal terminal shows an existing earlier open shift separately from today's row, with its original working date and saved shift end. Clock Out remains available after an overnight-to-daytime policy change.
- Missing completed working days appear as absence outcomes in history without invented check-in/out timestamps or retrospective monetary deductions. Weekends, holidays and approved full leave are classified separately. CEO/Super Admin can confirm an absence deduction or mark presence without a deduction; monthly totals identify pending reviews.
- History respects known employment dates, termination and recorded reactivation gaps. A hidden calendar checkpoint avoids rescanning a user's entire employment history on every refresh. Unknown inactive history is not inferred; original attendance remains queryable.
- Failed/stale roster refreshes clear previous rows and disable their actions. Company history refreshes with the terminal, and action handlers recheck the current working date before applying an override.
- Leave, repair and financial-review dialogs scroll within short screens. Weekday controls fit narrow phones; intentional horizontal scrolling stays inside history/ledger tables.

Compatibility: an existing approved leave of exactly 0.5 days without a session is interpreted as a morning half-day. New half-day requests explicitly choose morning or afternoon. Derived historic calendar rows use available calendar information; they are not proof of physical absence and require administrator review before charging wages.

Follow-up review on 14 October additionally corrected override/approval races, historical wage/calendar selection, pre-employment attendance creation, morning-half work hours, stale closure writes, afternoon-half no-show timing and direct legacy checkout. Overrides now transact with the same employee lock as check-in/leave approval. Existing records keep their saved reference wage/calendar. Verified presence has an explicit zero-deduction mode. Today returns personal half-shift times/day-off status; the UI permits actual arrival after an inferred no-show and clears unavailable history/leave data. Company-history changes refresh the parent terminal/roster. Details: [follow-up audit](D:/neximet-platform/output/attendance-follow-up-2026-10-14.md).

Validation:

Latest concurrency/recovery review additionally preserves presence waivers during leave reconciliation, repairs canonical browser locks, guards quarantine writes and frontend confirmations against changed records, fixes antipodal GPS calculations, resolves historical roster membership and reconciles calendar generation against concurrent leave approval. The calendar coverage check uses the same transaction lock as approval and can resume interrupted generation. See [latest audit](D:/neximet-platform/output/attendance-concurrency-audit-2026-10-14.md).

- Backend: `npm run test:attendance` — 79 tests passed using a disposable localhost MongoDB replica set; no application environment file or production database is loaded. Coverage includes server calendar durations, half shifts/hours, concurrent balance/approval/check-in/override/calendar races, saved wage/calendar handling, corrupt images, finite geofence distances, no-show history, employment boundaries, quarantine/repair, stale confirmations, financial reconciliation, complete filtered totals and employee privacy. Additional cases cover repeat-penalty reductions, partial saved shift policies, guarded compensation updates, invalid/zero amounts, missing signing secret and dashboard authorization/current balances.
- Backend chat regression: `npm run test:chat` — 13 tests passed.
- Frontend: `node --test scripts/attendance.test.mjs scripts/chat.test.mjs scripts/pwa.test.mjs scripts/pwa-updates.test.mjs scripts/pwa-banners.test.mjs` — 40 tests passed, including viewed record identity/version, finite GPS distances, automatic/manual absence and quarantine action boundaries, stale roster rejection, saved shift display, authoritative dashboard status, guarded compensation payloads, zero pay, history preset boundaries and PWA behavior.
- Frontend production build and TypeScript validation passed.
- Browser checks used disposable fixture data: clock-in/out, pagination, Super Admin absence confirmation/cancel/restore, and the third-late/full-day simulator. Attendance was checked at phone width; deductions at 320, 768 and 1440 pixels had no document overflow. The 320-pixel confirmation modal remained inside the viewport.

Deployment: deploy the backend and frontend together. Install backend dependencies from the updated lockfile (`npm ci`) so Sharp is available. The existing `MONGODB_URI` must point to MongoDB Atlas or a replica set that supports transactions; a standalone MongoDB server cannot perform atomic check-in, leave review, repair or employee compensation edits. The existing `JWT_SECRET` must be configured: the public fallback signing key was removed from HTTP, realtime and push token paths. No new environment-variable name is required. Historical deductions are not indiscriminately recalculated; approved leave and explicit administrator review are audited adjustments. No production migration or record edit was run. Evidence erased by the old implementation requires a backup to reconstruct.

The complete review finished on 15 October also reduces later monthly repeat penalties when an earlier late incident is excused, derives missing shift ends from saved snapshots without rewriting evidence, serializes/guards compensation edits, preserves zero pay, restricts company dashboard totals to executives, refreshes personal balances/status and blocks quarantine clock actions. See [complete findings and validation](D:/neximet-platform/output/attendance-complete-review-2026-10-15.md).

Device identifiers refer to browser profiles, and selfies are captured for administrator review; this implementation does not add facial recognition or biometric liveness verification. Actual Android GPS/camera permissions and hardware remain a device-level validation step.

The additional 15 October follow-up corrects standalone today/no-show visibility, wage snapshots for generated calendar rows, quarantine/simulation exclusions from operational and financial totals, prior monthly incident counting, legacy overnight early-arrival hours and overnight administrative alerts. Frontend fixes cover company-date leave/holiday display, obsolete settings responses and authoritative terminal repair/penalty labels. Validation now passes 92 backend attendance tests and 44 frontend regression tests, plus production build and TypeScript checks. See [the follow-up findings](../output/attendance-review-2026-10-15-followup.md) for reproductions and practical limits.

A further 15 October pass corrects narrow overnight quarantine windows, calendar gaps after working-date repair (including concurrent checkpoint writes), stale repair confirmations, misaligned repair schedules/hours, stuck history action locks, shared API failure handling, old-session policy/GPS completions and simulator wage initialization. Final validation passes 97 backend attendance tests and 49 frontend regressions, plus the production build/TypeScript checks. See [the follow-through review](../output/attendance-deep-review-2026-10-15.md).

The later 15 October recheck found and corrected rapid duplicate leave submissions, stale-session leave application/review completions, missing duration-quote retry and simulator range/value mismatches. Backend attendance remains at 97 passing tests; frontend regressions now total 55 passing tests, with production build/TypeScript checks passing. No additional backend defect was confirmed in this pass. See [the recheck](../output/attendance-recheck-2026-10-15.md).
