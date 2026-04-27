# Trengo Export Tools

A Node.js toolkit for exporting ticket and message data from Trengo API, following production-proven best practices for reliable data extraction at any scale.

## Overview

This repository contains two complementary scripts:

- **`trengo-export.js`** — Fetches all tickets and messages from Trengo API and exports them to JSON/CSV
- **`trengo-reprocess.js`** — Regenerates CSV/JSON output from existing JSON exports without re-fetching from the API

## Features

- ✅ Sequential pagination for reliable ticket fetching
- ✅ Parallel message fetching with 30 concurrent workers
- ✅ Exponential backoff retry logic
- ✅ Rate limit handling with Retry-After support
- ✅ Channel and date filtering
- ✅ Skip-on-failure fallback (continues export even if some tickets fail)
- ✅ Raw JSON + CSV output (two-file approach)
- ✅ Transcript generation for human-readable conversation logs

## Prerequisites

- Node.js 14+ (no external dependencies required)
- Trengo API token (account-scoped)

## Installation

1. Clone or download the scripts
2. Make them executable (optional):

```bash
chmod +x trengo-export.js trengo-reprocess.js
```

## Getting Your API Token

1. Log in to your Trengo account
2. Go to Settings → API & Webhooks
3. Generate a new API token
4. Keep it secure and never commit it to version control

## Script 1: trengo-export.js

Fetches tickets and messages from the Trengo API.

### Usage

```bash
node trengo-export.js [options]
```

### Options

| Option                 | Description                                           | Required |
| ---------------------- | ----------------------------------------------------- | -------- |
| `-t, --token <token>`  | API token (or set `TRENGO_API_TOKEN` env var)         | Yes      |
| `-c, --channels <ids>` | Comma-separated channel IDs (e.g., "265385,265390")   | No       |
| `--date-from <date>`   | Filter tickets created on or after date (ISO format)  | No       |
| `--date-to <date>`     | Filter tickets created on or before date (ISO format) | No       |
| `-o, --output <dir>`   | Output directory (default: `./trengo-export`)         | No       |
| `-h, --help`           | Show help message                                     | No       |

### Examples

**Export all tickets:**

```bash
node trengo-export.js --token YOUR_API_TOKEN
```

**Export with environment variable:**

```bash
export TRENGO_API_TOKEN=your_token_here
node trengo-export.js
```

**Export specific channels:**

```bash
node trengo-export.js --token YOUR_TOKEN --channels 265385,265390
```

**Export with date range:**

```bash
node trengo-export.js --token YOUR_TOKEN --date-from 2025-01-01 --date-to 2025-12-31
```

**Export to custom directory:**

```bash
node trengo-export.js --token YOUR_TOKEN -o ./exports/january-2025
```

### Output Files

The script creates the following files in the output directory:

| File                 | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `trengo_export.json` | Full ticket objects with embedded messages arrays (source of truth)    |
| `trengo_export.csv`  | Flattened summary with one row per ticket and conversation transcripts |
| `summary.txt`        | Export summary with ticket/message counts and metadata                 |

### CSV Columns

- `ticket_id` — Unique ticket identifier
- `subject` — Ticket subject line
- `status` — open, closed, spam, etc.
- `created_at` — Ticket creation timestamp
- `updated_at` — Last update timestamp
- `contact_id` — ID of the associated contact
- `team_id` — Assigned team ID
- `channel_id` — Channel ID
- `assignee_id` — Assigned user ID
- `message_count` — Total number of messages in the ticket
- `transcript` — Full conversation as formatted text

## Script 2: trengo-reprocess.js

Regenerates CSV/JSON output from an existing JSON export without re-fetching from the API. Useful for reformatting, reprocessing, or re-analyzing data.

### Usage

```bash
node trengo-reprocess.js [options]
```

### Options

| Option                  | Description                                     | Required |
| ----------------------- | ----------------------------------------------- | -------- |
| `-i, --input <file>`    | Input JSON file from trengo-export.js           | Yes      |
| `-o, --output <dir>`    | Output directory (default: same as input file)  | No       |
| `-f, --format <format>` | Output format: `csv` or `json` (default: `csv`) | No       |
| `-h, --help`            | Show help message                               | No       |

### Examples

**Regenerate CSV from existing export:**

```bash
node trengo-reprocess.js -i ./trengo-export/trengo_export.json
```

**Export to different directory:**

```bash
node trengo-reprocess.js -i ./trengo-export/trengo_export.json -o ./reports
```

**Export as JSON (filtered/reformatted):**

```bash
node trengo-reprocess.js -i ./trengo-export/trengo_export.json -f json
```

## Typical Workflow

1. **Initial Export** (one time, may take hours for large datasets):

   ```bash
   node trengo-export.js --token YOUR_TOKEN -o ./exports/full-backup
   ```

2. **Reprocess for different formats** (seconds/minutes):
   ```bash
   # Generate CSV for analysis
   node trengo-reprocess.js -i ./exports/full-backup/trengo_export.json -o ./reports
   ```

## Performance Expectations

Based on production exports:

| Tickets | Messages  | Runtime     | Configuration                 |
| ------- | --------- | ----------- | ----------------------------- |
| ~6,000  | ~59,000   | A few hours | 30 workers, 6 channels        |
| ~25,000 | ~180,000  | ~6 hours    | 30 workers, single channel    |
| ~95,000 | ~500,000+ | ~18 hours   | Sequential pages + 30 workers |

_Assumes rate limit of 2,000 requests/minute. Standard accounts (120 req/min) will take proportionally longer._

## Important Notes

### Pagination

- Tickets are fetched **sequentially** using `links.next` only
- Do NOT attempt parallel page fetching — this can cause missed tickets
- The API sorts by `latest_message_at`, not `created_at`

### Date Filtering

- Date filters are applied **client-side** after fetching all tickets
- The API does not support `date_from` or `date_to` query parameters
- Do not terminate pagination early based on dates — this causes data loss

### Channel Filtering

- Use `--channels` with IDs (e.g., `265385,265390`)
- The parameter must be `channels[]` (with square brackets) — the script handles this automatically

### Message Content

- Message text is in the `message` field (not `body`)
- Message types: `incoming` (customer), `outgoing` (agent), `note` (internal)

### Reliability

- 30-second timeout for API requests
- Exponential backoff: 5s × 2^attempt
- Max 4 retries per request
- Skip-on-failure for individual tickets (export continues even if some fail)

## Troubleshooting

### "Rate limit exceeded" warnings

These are normal. The script automatically waits and retries based on the `Retry-After` header.

### Export seems stuck

Large exports can take hours. Check the progress output — it shows page numbers and ticket counts as it progresses.

### Missing messages for some tickets

This is expected behavior when a ticket fails after all retries. Check the console output for warnings about specific ticket IDs.

### 502/503/504 errors

These are temporary server errors. The script will retry with exponential backoff.

### Date filters not working

Date filters are applied after fetching all tickets. Old and new tickets are interleaved in results, so the script must fetch everything first.

## Security Best Practices

1. **Never commit your API token to version control**
2. Use environment variables or `.env` files (add `.env` to `.gitignore`)
3. Set restrictive permissions on output files containing customer data
4. Delete exports when no longer needed

## License

MIT
