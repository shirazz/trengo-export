#!/usr/bin/env node
/**
 * Trengo Export Reprocessor
 *
 * Regenerates CSV/Excel output from raw JSON export without re-fetching from API.
 * This allows reformatting, reprocessing, or re-analyzing data quickly.
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    inputFile: null,
    outputDir: null,
    format: 'csv', // csv or json
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
      case '-i':
        options.inputFile = args[++i];
        break;
      case '--output':
      case '-o':
        options.outputDir = args[++i];
        break;
      case '--format':
      case '-f':
        options.format = args[++i];
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
    }
  }

  if (!options.inputFile) {
    console.error('Error: Input file is required. Use --input or -i.');
    showHelp();
    process.exit(1);
  }

  // Default output directory to same as input
  if (!options.outputDir) {
    options.outputDir = path.dirname(options.inputFile);
  }

  return options;
}

function showHelp() {
  console.log(`
Usage: node trengo-reprocess.js [options]

Options:
  -i, --input <file>      Input JSON file from trengo-export.js
  -o, --output <dir>      Output directory (default: same as input)
  -f, --format <format>   Output format: csv, json (default: csv)
  -h, --help              Show this help message

Examples:
  node trengo-reprocess.js -i ./trengo-export/trengo_export.json
  node trengo-reprocess.js -i ./trengo-export/trengo_export.json -o ./reports -f csv
  node trengo-reprocess.js -i ./trengo-export/trengo_export.json -f json
`);
}

// Format timestamp for transcript
function formatTimestamp(dateString) {
  const date = new Date(dateString);
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

// Get sender name from message
function getSenderName(message) {
  if (message.type === 'incoming') {
    return 'Customer';
  } else if (message.type === 'outgoing') {
    return message.agent?.name || message.agent?.email || 'Agent';
  } else if (message.type === 'note') {
    return message.agent?.name || message.agent?.email || 'Note';
  }
  return 'Unknown';
}

// Build transcript from messages
function buildTranscript(messages) {
  if (!messages || messages.length === 0) {
    return '';
  }

  // Sort by created_at
  const sorted = [...messages].sort((a, b) => {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return sorted.map(m => {
    const timestamp = formatTimestamp(m.created_at);
    const sender = getSenderName(m);
    const content = (m.message || '').replace(/\n/g, ' ');
    return `[${timestamp}] ${sender}: ${content}`;
  }).join('\n');
}

// Escape CSV field
function escapeCSV(field) {
  if (field === null || field === undefined) {
    return '';
  }
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Convert tickets to CSV
function convertToCSV(tickets) {
  const headers = [
    'ticket_id',
    'subject',
    'status',
    'created_at',
    'updated_at',
    'contact_id',
    'team_id',
    'channel_id',
    'assignee_id',
    'message_count',
    'transcript',
  ];

  const rows = tickets.map(ticket => {
    const messages = ticket.messages || [];
    const transcript = buildTranscript(messages);

    return [
      ticket.id,
      ticket.subject || '',
      ticket.status || '',
      ticket.created_at || '',
      ticket.updated_at || '',
      ticket.contact?.id || '',
      ticket.team?.id || '',
      ticket.channel?.id || '',
      ticket.assignee?.id || '',
      messages.length,
      transcript,
    ].map(escapeCSV).join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

// Filter tickets by date
function filterByDate(tickets, dateFrom, dateTo) {
  return tickets.filter(ticket => {
    const createdAt = new Date(ticket.created_at);

    if (dateFrom && createdAt < dateFrom) {
      return false;
    }
    if (dateTo && createdAt > dateTo) {
      return false;
    }
    return true;
  });
}

// Filter tickets by status
function filterByStatus(tickets, statuses) {
  if (!statuses || statuses.length === 0) {
    return tickets;
  }
  return tickets.filter(ticket => statuses.includes(ticket.status));
}

// Filter tickets by channel
function filterByChannel(tickets, channelIds) {
  if (!channelIds || channelIds.length === 0) {
    return tickets;
  }
  return tickets.filter(ticket => channelIds.includes(ticket.channel?.id));
}

// Main reprocess function
async function reprocess() {
  const options = parseArgs();

  console.log('Trengo Export Reprocessor');
  console.log('=========================');
  console.log(`Input File: ${options.inputFile}`);
  console.log(`Output Directory: ${options.outputDir}`);
  console.log(`Output Format: ${options.format}`);
  console.log('');

  // Load JSON file
  console.log('Loading data...');
  let tickets;
  try {
    const data = fs.readFileSync(options.inputFile, 'utf-8');
    tickets = JSON.parse(data);
  } catch (error) {
    console.error('Error loading input file:', error.message);
    process.exit(1);
  }

  console.log(`Loaded ${tickets.length} tickets`);

  // Create output directory if it doesn't exist
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  // Generate output filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `trengo_reprocessed_${timestamp}`;

  if (options.format === 'csv') {
    const csvPath = path.join(options.outputDir, `${baseName}.csv`);
    const csv = convertToCSV(tickets);
    fs.writeFileSync(csvPath, csv);
    console.log(`Saved CSV: ${csvPath}`);
  } else if (options.format === 'json') {
    const jsonPath = path.join(options.outputDir, `${baseName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(tickets, null, 2));
    console.log(`Saved JSON: ${jsonPath}`);
  } else {
    console.error(`Unknown format: ${options.format}`);
    process.exit(1);
  }

  // Print summary
  const totalMessages = tickets.reduce((sum, t) => sum + (t.messages?.length || 0), 0);
  console.log(`\nSummary:`);
  console.log(`  Total Tickets: ${tickets.length}`);
  console.log(`  Total Messages: ${totalMessages}`);
  console.log(`  Average Messages per Ticket: ${(totalMessages / tickets.length).toFixed(2)}`);

  // Status breakdown
  const statusCounts = tickets.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nStatus Breakdown:`);
  Object.entries(statusCounts)
    .sort(([,a], [,b]) => b - a)
    .forEach(([status, count]) => {
      console.log(`  ${status}: ${count}`);
    });

  console.log('\nReprocessing complete!');
}

// Run the reprocessor
reprocess().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
