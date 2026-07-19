# Oldham County Magistrate Document Monitor

This monitor opens the live Oldham County magistrate-document page in a real Chromium browser every two hours, extracts the meeting sections and document links, compares them with the last successful inventory, and publishes a concise status record.

Monitored page:

- `https://www.oldhamcountyky.gov/magistratedocs2026`

Public outputs after the workflow runs on the default branch:

- `status.json` — latest machine-readable result
- `latest.log.txt` — latest human-readable log entry
- `current.json` — latest fully successful inventory
- `runs.jsonl` — rolling run history
- `changes.jsonl` — rolling history of changes and failures

## What counts as a successful no-change run

The monitor only reports no changes when all of the following succeed:

1. Chromium directly opens the exact live URL.
2. The HTTP response is successful.
3. The magistrate-materials marker is found.
4. The complete monitored section reaches the page footer.
5. At least one meeting section and one uploaded-document link are extracted.
6. The new inventory is compared with the previous successful inventory.

A timeout, CAPTCHA, blocked browser, missing page section, partial extraction, or comparison problem is reported as a failure rather than as “no changes.”

## Schedule

GitHub Actions uses UTC. The workflow is scheduled at minute 15 of every second UTC hour. GitHub may occasionally start scheduled jobs a few minutes late.

The workflow can also be run manually from **Actions → Oldham Magistrate Monitor → Run workflow**.
