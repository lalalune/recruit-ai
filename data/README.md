# Local data

This directory holds the SQLite database and public-page snapshots created by RecruitAI. API keys and OAuth tokens are stored in the database’s local secrets table unless an environment variable overrides them.

Everything except this README and `.gitkeep` is ignored by Git. Do not commit, publish, attach, or paste files from this directory into issues.

The contents may include professional contact information and credentials:

- lock and encrypt the OS account;
- keep backups encrypted;
- rotate any credential that is accidentally exposed;
- stop the app or use a SQLite-aware backup rather than copying only the main database while WAL mode is active; and
- never place LinkedIn cookies or browser profiles here—the app does not support authenticated LinkedIn scraping.

Development uses this directory by default. Packaged builds should use the current operating system’s per-user application-data directory.
