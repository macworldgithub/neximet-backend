# Attendance fixes

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
- History/roster responses contain photo indicators rather than every full-size selfie. Photos have a private owner/executive endpoint and no-store responses.
- Approved full-day leave and mandatory holidays appear distinctly in the roster/dashboard. Working on those exempt days does not receive a late penalty. Weekends are not assumed to be nonworking days.
- Company staff counters use the same active employee population and exclude CEO test attendance. Full-day late absence does not also count as present attendance.
- Monthly payroll excludes simulations, distinguishes absence from lateness and restricts Project Managers to their departments. Super Admin ledger access now works.
- The deductions simulator uses the backend calculation instead of a separate frontend formula. CEO arrival simulations are relative to the configured shift and current working day.
- Settings reads no longer create duplicate default policies. Concurrent/stale policy edits cannot silently overwrite a saved configuration. Policy editing is disabled until the saved policy loads successfully, with a reload control for recovery.
- The frontend has consistent company-time clocks, live leave balances, history pagination, explicit clock-out and admin confirmation controls, request timeouts and visible errors. Camera streams are stopped on cancellation, retake and unmount, including streams resolving after a modal closes.
- Malformed legacy dates are skipped during automatic shift closure so they cannot break other employees' attendance or be silently rewritten.

Validation:

- Backend: `npm run test:attendance` — 30 tests (7 policy tests and 23 API tests using a temporary localhost database); no application environment file or production database is loaded.
- Backend chat regression: `npm run test:chat` — 13 tests passed.
- Frontend: `node --test scripts/attendance.test.mjs scripts/chat.test.mjs scripts/pwa.test.mjs scripts/pwa-updates.test.mjs` — 27 tests passed.
- Frontend production build and TypeScript validation passed.
- Browser checks used disposable fixture data: clock-in/out, pagination, Super Admin absence confirmation/cancel/restore, and the third-late/full-day simulator. Attendance was checked at phone width; deductions at 320, 768 and 1440 pixels had no document overflow. The 320-pixel confirmation modal remained inside the viewport.

Deployment: deploy the backend and then the frontend together because the frontend uses the new photo endpoint and pagination/shift fields. No new environment variables are required. Historical deductions are not automatically recalculated, and evidence erased by the old implementation cannot be reconstructed without a backup. Production records were not used or edited during validation.

Device identifiers refer to browser profiles, and selfies are captured for administrator review; this implementation does not add facial recognition or biometric liveness verification. Actual Android GPS/camera permissions and hardware remain a device-level validation step.
