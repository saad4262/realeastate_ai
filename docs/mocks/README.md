# Design mocks

The source of truth for what the public pages are supposed to look like.

This directory exists because the mock was lost once. The consumer pages were
built from it, the values were deliberately changed, the reason was recorded —
and when the result was questioned there was nothing in the repository to
compare against, because whatever had been pasted into a chat window was gone.
Rebuilding meant guessing from two screenshots, and the guess was wrong: warm
crimson on neutral grey, where the mock is cool slate with `#E11D48`.

**Anything a page is built to belongs in here, committed.**

## What is here

| File                   | Screen                                                |
| ---------------------- | ----------------------------------------------------- |
| `listing-detail.html`  | 12/1A Rogers Street, Pakenham VIC 3810 — Property Listing |
| `listing-detail.png`   | The same screen, rendered (1400 × 5296)               |

## Where it came from

Google Stitch, project **"Remix of LocalAgentHub Agency Operating System"**,
id `11207375819501221556`, screen `8b6631d3f1a9414c8030c8d01c167baf`.

Stitch exposes an MCP server at `https://stitch.googleapis.com/mcp` and the key
lives in `.cursor/mcp.json`, which is gitignored. `get_screen` returns download
URLs for the HTML and the screenshot:

```sh
KEY=$(python3 -c "import json;print(json.load(open('.cursor/mcp.json'))['mcpServers']['stitch']['headers']['X-Goog-Api-Key'])")
curl -sS -X POST https://stitch.googleapis.com/mcp \
  -H "X-Goog-Api-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_screen",
        "arguments":{"name":"projects/<projectId>/screens/<screenId>"}}}'
```

The screenshot URL is an `lh3.googleusercontent.com` link and defaults to a
thumbnail. Append a size suffix — `=w1400` — or you get 135 × 512.

`list_screens` with `{"projectId": "<id>"}` lists the rest of the project.

## How it is used

The mock's own Tailwind config is in the `<script id="tailwind-config">` block
of the HTML, and it is the authority on the palette. `apps/web/app/tailwind.css`
reads its values into the `[data-skin='portal']` block, token by token, with the
mock's names in the comments so the two can be checked against each other.

**Structure is followed; data is not invented.** The mock carries a 24-photo
gallery, an energy rating, an inclusions schedule, a floorplan, CoreLogic
medians, a rental yield, days on market, school catchments and a mortgage
estimator. This platform has a source for none of them, and a plausible median
is the fabricated number non-negotiable #4 exists to forbid. Sections without a
source are named in one line rather than drawn — see `NotConnected` in
`apps/web/components/listing-sections.tsx`.
