#!/usr/bin/env node
/**
 * Trengo Ticket & Message Export Script
 *
 * Exports all tickets and messages from Trengo API following best practices:
 * - Sequential pagination for tickets (links.next only)
 * - Parallel message fetching with concurrency control
 * - Exponential backoff retries
 * - Outputs raw JSON and CSV
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// Configuration
const CONFIG = {
  BASE_URL: "app.trengo.com",
  API_PATH: "/api/v2",
  TIMEOUT_MS: 30000,
  MAX_RETRIES: 4,
  MESSAGE_WORKERS: 30,
  RETRY_DELAY_BASE_S: 5,
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    token: process.env.TRENGO_API_TOKEN,
    channels: [],
    dateFrom: null,
    dateTo: null,
    outputDir: "./trengo-export",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
      case "-t":
        options.token = args[++i];
        break;
      case "--channels":
      case "-c":
        options.channels = args[++i].split(",").map(Number);
        break;
      case "--date-from":
        options.dateFrom = new Date(args[++i]);
        break;
      case "--date-to":
        options.dateTo = new Date(args[++i]);
        break;
      case "--output":
      case "-o":
        options.outputDir = args[++i];
        break;
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
    }
  }

  if (!options.token) {
    console.error(
      "Error: API token is required. Use --token or set TRENGO_API_TOKEN env var.",
    );
    showHelp();
    process.exit(1);
  }

  return options;
}

function showHelp() {
  console.log(`
Usage: node trengo-export.js [options]

Options:
  -t, --token <token>     API token (or set TRENGO_API_TOKEN env var)
  -c, --channels <ids>    Comma-separated channel IDs (e.g., "265385,265390")
  --date-from <date>      Filter tickets created on or after date (ISO format)
  --date-to <date>        Filter tickets created on or before date (ISO format)
  -o, --output <dir>      Output directory (default: ./trengo-export)
  -h, --help              Show this help message

Examples:
  node trengo-export.js --token abc123
  node trengo-export.js --token abc123 --channels 265385,265390
  node trengo-export.js --token abc123 --date-from 2025-01-01 --date-to 2025-12-31
  TRENGO_API_TOKEN=abc123 node trengo-export.js -c 265385 -o ./my-export
`);
}

// HTTP Request helper with retries
function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `https://${CONFIG.BASE_URL}`);

    // Add query parameters
    if (options.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(`${key}[]`, v));
        } else {
          url.searchParams.append(key, value);
        }
      });
    }

    const requestOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "TrengoExport/1.0",
        ...options.headers,
      },
      timeout: CONFIG.TIMEOUT_MS,
    };

    const req = https.request(requestOptions, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        // Handle rate limiting
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers["retry-after"], 10) || 5;
          reject({
            statusCode: 429,
            retryAfter,
            message: "Rate limit exceeded",
          });
          return;
        }

        // Handle server errors
        if (res.statusCode >= 500) {
          reject({
            statusCode: res.statusCode,
            message: `Server error: ${res.statusCode}`,
          });
          return;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve({
              data: json,
              headers: res.headers,
              statusCode: res.statusCode,
            });
          } catch (e) {
            reject({
              message: "Failed to parse JSON response",
              error: e.message,
            });
          }
        } else {
          reject({
            statusCode: res.statusCode,
            message: `HTTP error: ${res.statusCode}`,
            body: data,
          });
        }
      });
    });

    req.on("error", (error) => {
      reject({ message: "Request error", error: error.message });
    });

    req.on("timeout", () => {
      req.destroy();
      reject({ message: "Request timeout" });
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

// Request with exponential backoff retry
async function requestWithRetry(path, options, attempt = 0) {
  try {
    return await makeRequest(path, options);
  } catch (error) {
    const isRetryable =
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode < 600) ||
      error.message?.includes("timeout");

    if (isRetryable && attempt < CONFIG.MAX_RETRIES) {
      const delay = error.retryAfter
        ? error.retryAfter * 1000
        : CONFIG.RETRY_DELAY_BASE_S * Math.pow(2, attempt) * 1000;

      console.log(
        `  Retry ${attempt + 1}/${CONFIG.MAX_RETRIES} after ${delay}ms for ${path}`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return requestWithRetry(path, options, attempt + 1);
    }

    throw error;
  }
}

// Fetch all tickets with sequential pagination
async function fetchAllTickets(options) {
  const tickets = [];
  let pageCount = 0;

  // Build initial URL with channel filters
  const params = {};
  if (options.channels.length > 0) {
    params["channels[]"] = options.channels;
  }

  let nextUrl = `${CONFIG.API_PATH}/tickets`;
  let queryParams = { ...params };

  console.log("Fetching tickets...");

  while (nextUrl) {
    pageCount++;
    process.stdout.write(`  Page ${pageCount}... `);

    try {
      const response = await requestWithRetry(nextUrl, {
        token: options.token,
        params: queryParams,
      });

      const data = response.data;
      console.log(`Fetched JSON: ${JSON.stringify(data)} tickets`);

      if (data.data && Array.isArray(data.data)) {
        tickets.push(...data.data);
        process.stdout.write(
          `${data.data.length} tickets (total: ${tickets.length})\n`,
        );
      }

      // Follow links.next for pagination
      nextUrl = data.links?.next || null;
      queryParams = {}; // Reset params after first request

      // Convert full URL to path if needed
      if (nextUrl && nextUrl.startsWith("http")) {
        const urlObj = new URL(nextUrl);
        nextUrl = urlObj.pathname + urlObj.search;
      }
    } catch (error) {
      console.error(`\n  Error fetching page ${pageCount}:`, error.message);
      throw error;
    }
  }

  console.log(`\nTotal tickets fetched: ${tickets.length}`);

  // Apply date filters client-side
  let filteredTickets = tickets;

  if (options.dateFrom || options.dateTo) {
    console.log("Applying date filters...");
    filteredTickets = tickets.filter((ticket) => {
      const createdAt = new Date(ticket.created_at);

      if (options.dateFrom && createdAt < options.dateFrom) {
        return false;
      }
      if (options.dateTo && createdAt > options.dateTo) {
        return false;
      }
      return true;
    });
    console.log(`  After filtering: ${filteredTickets.length} tickets`);
  }

  return filteredTickets;
}

// Fetch messages for a single ticket
async function fetchMessagesForTicket(ticketId, token) {
  const path = `${CONFIG.API_PATH}/tickets/${ticketId}/messages`;

  try {
    const response = await requestWithRetry(path, { token });
    return response.data.data || [];
  } catch (error) {
    console.warn(
      `  Failed to fetch messages for ticket ${ticketId}: ${error.message}`,
    );
    return []; // Skip-on-failure fallback
  }
}

// Fetch messages for all tickets in parallel with concurrency control
async function fetchAllMessages(tickets, token) {
  console.log(
    `\nFetching messages for ${tickets.length} tickets with ${CONFIG.MESSAGE_WORKERS} workers...`,
  );

  const results = new Map();
  const queue = [...tickets];
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (queue.length > 0) {
      const ticket = queue.shift();
      const ticketId = ticket.id;

      try {
        const messages = await fetchMessagesForTicket(ticketId, token);
        results.set(ticketId, messages);

        completed++;
        if (completed % 100 === 0 || completed === tickets.length) {
          process.stdout.write(
            `\r  Progress: ${completed}/${tickets.length} (${failed} failed)`,
          );
        }
      } catch (error) {
        failed++;
        results.set(ticketId, []);
        console.error(
          `\n  Error fetching messages for ticket ${ticketId}:`,
          error.message,
        );
      }
    }
  }

  // Start workers
  const workers = Array(CONFIG.MESSAGE_WORKERS)
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);

  console.log(`\n  Completed: ${completed}, Failed: ${failed}`);

  return results;
}

// Format timestamp for transcript
function formatTimestamp(dateString) {
  const date = new Date(dateString);
  return date.toISOString().replace("T", " ").slice(0, 16);
}

// Get sender name from message
function getSenderName(message) {
  if (message.type === "incoming") {
    return "Customer";
  } else if (message.type === "outgoing") {
    return message.agent?.name || message.agent?.email || "Agent";
  } else if (message.type === "note") {
    return message.agent?.name || message.agent?.email || "Note";
  }
  return "Unknown";
}

// Build transcript from messages
function buildTranscript(messages) {
  if (!messages || messages.length === 0) {
    return "";
  }

  // Sort by created_at
  const sorted = [...messages].sort((a, b) => {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return sorted
    .map((m) => {
      const timestamp = formatTimestamp(m.created_at);
      const sender = getSenderName(m);
      const content = (m.message || "").replace(/\n/g, " ");
      return `[${timestamp}] ${sender}: ${content}`;
    })
    .join("\n");
}

// Escape CSV field
function escapeCSV(field) {
  if (field === null || field === undefined) {
    return "";
  }
  const str = String(field);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Convert tickets and messages to CSV
function convertToCSV(tickets, messagesMap) {
  const headers = [
    "ticket_id",
    "subject",
    "status",
    "created_at",
    "updated_at",
    "contact_id",
    "team_id",
    "channel_id",
    "assignee_id",
    "message_count",
    "transcript",
  ];

  const rows = tickets.map((ticket) => {
    const messages = messagesMap.get(ticket.id) || [];
    const transcript = buildTranscript(messages);

    return [
      ticket.id,
      ticket.subject || "",
      ticket.status || "",
      ticket.created_at || "",
      ticket.updated_at || "",
      ticket.contact?.id || "",
      ticket.team?.id || "",
      ticket.channel?.id || "",
      ticket.assignee?.id || "",
      messages.length,
      transcript,
    ]
      .map(escapeCSV)
      .join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

// Save results to files
async function saveResults(tickets, messagesMap, outputDir) {
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Build full data structure
  const fullData = tickets.map((ticket) => ({
    ...ticket,
    messages: messagesMap.get(ticket.id) || [],
  }));

  // Save raw JSON
  const jsonPath = path.join(outputDir, "trengo_export.json");
  fs.writeFileSync(jsonPath, JSON.stringify(fullData, null, 2));
  console.log(`\nSaved raw JSON: ${jsonPath}`);

  // Save CSV
  const csvPath = path.join(outputDir, "trengo_export.csv");
  const csv = convertToCSV(tickets, messagesMap);
  fs.writeFileSync(csvPath, csv);
  console.log(`Saved CSV: ${csvPath}`);

  // Save summary
  const summaryPath = path.join(outputDir, "summary.txt");
  const summary = `Trengo Export Summary
=====================
Export Date: ${new Date().toISOString()}
Total Tickets: ${tickets.length}
Total Messages: ${Array.from(messagesMap.values()).reduce((sum, msgs) => sum + msgs.length, 0)}

Files Generated:
- trengo_export.json: Full data with embedded messages
- trengo_export.csv: Flattened summary with transcripts
`;
  fs.writeFileSync(summaryPath, summary);
  console.log(`Saved summary: ${summaryPath}`);
}

// Main export function
async function runExport() {
  const startTime = Date.now();
  const options = parseArgs();

  console.log("Trengo Ticket Export");
  console.log("====================");
  console.log(`Output Directory: ${options.outputDir}`);
  if (options.channels.length > 0) {
    console.log(`Channels: ${options.channels.join(", ")}`);
  }
  if (options.dateFrom) {
    console.log(`Date From: ${options.dateFrom.toISOString()}`);
  }
  if (options.dateTo) {
    console.log(`Date To: ${options.dateTo.toISOString()}`);
  }
  console.log("");

  try {
    // Step 1: Fetch all tickets
    const tickets = await fetchAllTickets(options);

    if (tickets.length === 0) {
      console.log("No tickets found matching the criteria.");
      return;
    }

    // Step 2: Fetch messages for all tickets
    const messagesMap = await fetchAllMessages(tickets, options.token);

    // Step 3: Save results
    await saveResults(tickets, messagesMap, options.outputDir);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    console.log(`\nExport completed in ${duration} minutes`);
  } catch (error) {
    console.error("\nExport failed:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the export
runExport();
