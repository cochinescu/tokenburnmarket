# tokenburnmarket — Ubiquitous Language

Glossary only. No implementation details.

## Terms

- **Builder** — a signed-in person (GitHub account; handle is the GitHub login). Owns one or more Devices, belongs to Communities, holds Credits.
- **Device** — a Builder's machine running the Collector. Bound to the Builder by approving a short code in the browser; identified by a keypair generated on first connect; the source of all Usage.
- **Collector** — the local program (`npx tokenburnmarket`) that reads agent transcripts through ccusage, signs the aggregates, and uploads them. Also exposes an MCP server to the agent.
- **Usage** — token counts and estimated cost per (Builder, Device, day, provider, model). The only faucet for Credits and the oracle for Markets.
- **Verified** — see Trust Level. Means "not obviously fake", not proof.
- **Credit** — the play currency. Minted from Usage once per closed day on a curve that flattens above a daily kink (whales earn more, not proportionally more); a small grant on signup; spent and won on Markets; never bought or cashed out.
- **Credits Won** — over a period: what Markets paid out plus what selling shares returned, less what buying them cost. The signup grant and the daily mint are not winnings. One of the three Leaderboard metrics, next to cost and tokens.
- **Community** — a group of Builders with its own leaderboards and Markets. Joined by invite. *Public* Communities appear in the directory; *Unlisted* ones are reachable only by URL and are not indexed. One Builder owns it; the rest are members.
- **Invite Code** — the secret in a Community's join link. Rotating it replaces the code, so every link handed out before stops working; nobody already in is removed.
- **Leaderboard** — a ranking of Builders by a metric over a period, scoped to a Community, a region, or global.
- **Market** — a question about future Usage with a fixed resolution time and 2+ outcomes, priced by a house-backed automated market maker (always liquid; a winning share pays 1 Credit), paid in Credits, resolved automatically from Usage.
- **Position** — a Builder's holding of outcome shares in a Market.
- **Sync** — one signed upload from a Device: changed daily Usage rows plus the Receipt Stream for those days.
- **Receipt Stream** — the ordered hashes of per-message identifiers behind a day's Usage (no content). Lets the server dedupe two Devices reading the same transcripts and judge whether a day's Usage is coherent.
- **Trust Level** — how much a Usage row is believed: *Verified* (signed Device + Receipt Stream + passed checks), *Reported* (signed Device, no usable Receipt Stream — identifiers are unavailable or receipts outnumber the tokens they support; mints Credits at a discount and is badged on Leaderboards), *Quarantined* (failed checks; excluded from Leaderboards, Credits, and Market resolution pending review).
- **Outcome** — one answer to a Market's question. Exactly one Outcome wins at resolution (or the Market is Voided).
- **Voided** — a Market cancelled before or at resolution (e.g. oracle data unusable); all Positions refunded at cost.
- **Hold** — a Market whose resolution waits because Usage it points at is Quarantined. It settles as soon as the review clears; if that has not happened a day later, the Market is Voided.
- **Season** — a Leaderboard period: this week (Mon–Sun UTC), this month, or all-time.
- **Region** — a Builder's self-declared country, and the continent it belongs to; either scopes a Leaderboard and its Markets. The world is the widest Region.
- **Model Race** — a global/regional Market on which model (or provider) burns the most tokens over a period.
- **Top Burner**, **Threshold**, **Head-to-Head** — the Community Market templates: who spends most, will X reach an amount, does A out-burn B.
- **Admin** — a Builder on the deployment's handle list. The only ones who may open a global or Region Market; a Community Market needs membership instead, and the owner can reserve it to themselves. Also the only ones who may review Quarantined Usage.
- **Review** — an Admin's decision about one Quarantined Usage row: approve it as Verified or Reported, which puts the day back into Leaderboards, Credits and Market resolution, or keep it out with a note. Approving only ever adds Credits; a day already minted is never clawed back.
