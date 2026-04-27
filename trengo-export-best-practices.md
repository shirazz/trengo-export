**Exporting conversation data via the Trengo API** 

Best practice guide 

This guide covers everything you need to export ticket and message data from Trengo at any scale — from a few hundred to hundreds of thousands of tickets. It captures patterns verified in production across multiple large-scale exports. 

Trengo — Exporting conversation data via APIPage 1  
**Before you start** 

**Authentication** 

All requests require a Bearer token in the Authorization header: 

| Authorization: Bearer \<your\_token\> Content-Type: application/json |
| :---- |

Your token is account-scoped. Keep it secret and never commit it to version control. 

**Base URL** 

| https://app.trengo.com/api/v2 |
| :---- |

⚠ **Note**   
The older api.trengo.com domain is deprecated. Always use app.trengo.com. 

**Rate limits** 

The standard rate limit is 120 requests per minute. Trengo employees and accounts on elevated limits may see up to 2,000 requests per minute — check the x-ratelimit-limit response header to confirm your account's limit. 

On a 429 response, read the Retry-After header (in seconds) and wait that duration before retrying. 

**Step 1 — List tickets** 

**The core pagination loop** 

Tickets are retrieved page by page from GET /tickets. The only reliable way to walk pages is to follow the links.next field in each response. When links.next is null, you have reached the last page. 

| url \= "https://app.trengo.com/api/v2/tickets" while url:   response \= requests.get(url, headers=headers, timeout=30)   data \= response.json()   process(data\["data"\])   url \= data\["links"\].get("next") \# None on last page |
| :---- |

⚠ **Note** 

Trengo — Exporting conversation data via APIPage 2  
meta.last\_page, meta.total, and links.last are never populated in the v2 API — they are always null. 

Do not use them as termination signals. 

**Why pagination must be sequential** 

The API sorts results by latest\_message\_at descending — not by created\_at. This means tickets with recent activity always appear near the top, and older tickets can appear hundreds of pages into the results. 

If you try to parallelise page fetching, an active ticket can receive a message mid-export and jump from page N back to page 1\. You will either miss it or create a gap. Sequential pagination is the only approach that guarantees full coverage. 

⚠ **Note**   
Using content-based early stopping — for example, stopping when several pages contain only old tickets — caused 94.6% data loss in a real export. 

Always paginate to completion using links.next only. 

**Filtering by channel** 

To export tickets from specific channels, use the channels\[\] parameter (with square brackets). The channel\_id parameter is silently ignored — the API returns all account tickets without any error or warning. 

| \# Correct — filters to specific channels params \= {"channels\[\]": \[265385, 265390\]}  \# Wrong — silently returns all tickets  params \= {"channel\_id": 265385} |
| :---- |

To find your channel IDs, call GET /channels. 

**Filtering by date** 

The Trengo API has no date\_from or date\_to query parameter. All date filtering must be applied client-side after fetching, using the created\_at field on each ticket: 

| tickets\_in\_range \= \[   t for t in all\_tickets   if t\["created\_at"\] \>= DATE\_FROM  \] |
| :---- |

⚠ **Note**   
Do not try to terminate pagination early based on dates.   
Because the API sorts by latest\_message\_at, old and new tickets are fully interleaved. You will miss data if you stop early. 

Trengo — Exporting conversation data via APIPage 3  
**Step 2 — Fetch messages** 

**The messages endpoint** 

Once you have your list of ticket IDs, fetch messages for each ticket: 

| GET /tickets/{id}/messages |
| :---- |

**The message content field** 

Message text is stored in the message field — not body. Using m.get("body") always returns empty with no error or warning. 

| \# Correct  content \= str(m.get("message", "") or "") \# handle None explicitly  \# Wrong — always returns empty  content \= m.get("body") |
| :---- |

Each message object has a type field: incoming (from the customer), outgoing (from an agent), or note (internal team note). 

**Parallelising message fetches** 

Unlike ticket list pagination, message fetching is safe to parallelise. Thirty concurrent workers has been tested and verified without hitting rate limits, consuming less than 5% of the available request budget per minute. 

from concurrent.futures import ThreadPoolExecutor   
import time 

def fetch\_messages(ticket\_id, headers, retries=4):   
 for attempt in range(retries):   
 try:   
 r \= requests.get(   
 f"https://app.trengo.com/api/v2/tickets/{ticket\_id}/messages",  headers=headers, 

 timeout=30   
 )   
 if r.status\_code \== 429:   
 wait \= int(r.headers.get("Retry-After", 5 \* 2\*\*attempt))  time.sleep(wait) 

 continue   
 r.raise\_for\_status()   
 return r.json().get("data", \[\])   
 except requests.exceptions.Timeout:   
 time.sleep(5 \* 2\*\*attempt)   
 return \[\] \# skip ticket after exhausted retries 

Trengo — Exporting conversation data via APIPage 4  
with ThreadPoolExecutor(max\_workers=30) as pool:   
 results \= list(pool.map(   
 lambda tid: fetch\_messages(tid, HEADERS),   
 ticket\_ids   
 )) 

**Step 3 — Build in reliability** 

**Timeouts** 

Use a timeout of at least 30 seconds — 60 seconds is safer. Pages deep in the results (page 200 and beyond) can take 15 or more seconds to respond. A 10-second timeout will cause unnecessary retry loops on large exports. 

**Retries with exponential backoff** 

The Trengo API occasionally returns 502, 503, or 504 errors during large exports. Implement exponential backoff for all 5xx responses: 

| MAX\_RETRIES \= 4 for attempt in range(MAX\_RETRIES):   try:   r \= requests.get(url, headers=headers, timeout=30)   if r.status\_code in (502, 503, 504):   time.sleep(5 \* 2\*\*attempt)   continue   r.raise\_for\_status()   break   except requests.exceptions.Timeout:   time.sleep(5 \* 2\*\*attempt) |
| :---- |

**Skip-on-failure fallback** 

For message fetches, implement a skip-on-failure fallback after exhausting retries. A single slow or broken ticket should not block the entire export. Log the failed ticket ID for inspection rather than letting the script crash. 

**Step 4 — Structure your output** 

**Two-file approach** 

We recommend producing two output files from every export: 

Trengo — Exporting conversation data via APIPage 5  
• Raw JSON — full ticket objects with embedded messages arrays. This acts as your source of truth and lets you regenerate any derived output without re-fetching from the API; 

• CSV or Excel — a flattened, human-readable summary with one row per ticket. Recommended CSV columns: 

| Column  | Description |
| :---- | :---- |
| ticket\_id  | Unique ticket identifier |
| subject  | Ticket subject line |
| status  | open, closed, spam, etc. |
| created\_at  | Ticket creation timestamp |
| updated\_at  | Last update timestamp |
| contact\_id  | ID of the associated contact |
| team\_id  | Assigned team ID |
| message\_count  | Total number of messages in the ticket |
| transcript  | Full conversation joined as text (see format below) |

**Transcript format** 

A readable transcript is useful for analysis and AI workflows. Format each message as a single line and join them with newlines: 

| \[YYYY-MM-DD HH:MM\] Sender: message text \# Example:  \[2026-04-01 09:14\] Customer: Hi, I need help with my order.  \[2026-04-01 09:16\] Agent: Of course — can you share your order number? |
| :---- |

**Separate your re-export script** 

Always write a second script that reads from your raw JSON file and generates the CSV or Excel output. This lets you reformat, reprocess, or re-analyse data without re-fetching everything from the API — which saves hours on large datasets. 

**Common pitfalls** 

| Pitfall  | Symptom  | Fix |
| :---- | :---- | :---- |

Trengo — Exporting conversation data via APIPage 6

| Content-based pagination stop | Up to 94% data loss  | Follow links.next only; always paginate to completion |
| ----- | ----- | :---- |
| channel\_id param  | Silently returns all tickets, filter ignored | Use channels\[\] with square  brackets |
| meta.last\_page /  links.last | Always null — no termination signal | Use links.next null check only |
| m.get("body") for message content | Always returns empty  | Use m.get("message") |
| 10-second timeout  | Retry loops on deep pages  | Use 30–60 second timeouts |
| No retries on 5xx  | Export fails mid-run  | Exponential backoff, four attempts |
| Date filter as API param  | Param does not exist; no error shown | Filter client-side on created\_at |
| Parallel ticket page fetching  | Missed tickets due to sort drift  | Sequential page fetching only |

**Scale reference** 

The table below shows observed performance from two production exports using the patterns in this guide. 

| Export  | Tickets  | Messages  | Runtime  | Configuration |
| :---- | :---- | :---- | :---- | :---- |
| Export A  | 95,279  | \~500,000+  | \~18 hours  | Sequential ticket pages \+ 30 parallel message workers |
| Export B  | \~6,000  | \~59,000  | A few hours  | 30 concurrent message  workers across six channels |
| Export C  | \~25,000  | \~180,000  | \~6 hours  | Single channel; sequential pages \+ 30 parallel message workers |

*All three exports were completed using an elevated rate limit of 2,000 requests per minute.* Trengo — Exporting conversation data via APIPage 7