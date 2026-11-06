# PromoCode Discord System

A Discord bot that tracks promo codes inside support tickets. Staff create codes and assign them to an owner, customers redeem a code in their ticket, and the bot handles view-only access for the code owner, commission calculation, balances and reports.

## Features

- **Admin-managed codes** — create a code and link it to a person with one command.
- **Redeem inside tickets** — a customer types `+code` in their ticket and the code is attached to it (one code per ticket).
- **View-only access for the code owner** — the owner can read the ticket but cannot send messages, react, upload files or anything else.
- **Automatic commission** — when a deal is settled, the owner earns **25%** of the ticket amount, tracked per user in USD.
- **Card-style reports** — daily automatic report plus on-demand reports (today or all time), built with Discord Components V2: a summary card, one card per code, and balance cards in the all-time report.
- **Safe deletion** — remove a code, today's data, or everything, with a confirmation step. Ticket permissions and balances are restored on removal.
- **Crash-safe storage** — data is written atomically to a local JSON file, and failed saves are rolled back.

## Requirements

- Node.js 18 or newer
- `discord.js` **14.19.0 or newer** (required for Components V2 reports)
- A Discord bot application with the **Message Content Intent** enabled (Developer Portal → Bot → Privileged Gateway Intents)
- Bot permissions in your server: `View Channels`, `Send Messages`, `Read Message History`, and **`Manage Channels`** (needed to edit ticket permissions for the code owner)

## Installation

```bash
git clone https://github.com/ziadkix/PromoCode-Discord-System.git
cd PromoCode-Discord-System
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_bot_token
PROMO_REPORT_CHANNEL_ID=your_report_channel_id
```

Start the bot:

```bash
npm start
```

## Commands

Commands marked **Admin** require the **Manage Server** permission.

| Command | Who | Description |
| --- | --- | --- |
| `+promo <code> @user` | Admin | Create a promo code and assign it to a user. |
| `+<code>` | Anyone | Redeem a code in the current ticket. The owner gets view-only access. |
| `+<amount>` | Admin | Settle the ticket, e.g. `+5.50`. The owner receives 25% of the amount. |
| `+data` | Admin | Send today's report (12:00 PM – 12:00 AM, Cairo time). |
| `+All` | Admin | Send the all-time report. Note the capital `A`. |
| `+remove <code>` | Admin | Delete a code with all its uses, tickets and settlements. |
| `+remove data` | Admin | Delete today's promo data. |
| `+remove all` | Admin | Delete all promo data for the server. |
| `+remove confirm` | Admin | Confirm a pending removal (valid for 60 seconds). |

> Code names can use letters, numbers, `_` and `-` (up to 32 characters). Avoid `promo`, `data`, `all` and `remove`, as they are reserved by commands.

## Reports

Reports (`+data`, `+All` and the daily report) are sent as Discord **Components V2** cards instead of plain text:

| Card | Shown in | Contents |
| --- | --- | --- |
| Summary | Every report | Number of codes and uses, total ticket sales, and the promo owners' total cut. |
| Code card | Every report | One card per code with its owner, uses, settled tickets, sales and the owner's cut. Codes created during the report window are marked **new today**. |
| Balance card | `+All` only | One card per user showing their current balance. |

Large reports are split automatically into several messages (up to 10 cards each), so nothing gets cut off. Mentions inside reports are displayed but never ping anyone.

## How it works

1. An admin creates a code: `+promo summer @someone`
2. A customer opens a ticket and types `+summer`. The code owner can now read the ticket but cannot write in it.
3. After agreeing on a price, an admin types `+5.50`. The bot records the sale and adds $1.38 to the owner's balance (25%, rounded to the nearest cent).
4. Every day after midnight (Cairo time) the bot posts the previous day's report in the configured channel. Use `+data` or `+All` any time for a live report.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Your bot token. |
| `PROMO_REPORT_CHANNEL_ID` | No* | Text channel ID where reports are sent. *Required for daily reports, `+data` and `+All`. |

The report timezone (`Africa/Cairo`) and commission rate (25%) are set directly in the source and can be changed there.

## Data storage

All data is saved to `promo-data.json` next to the bot. Back this file up if you run the bot in production, and never commit it.

## Security notes

- Never commit your `.env` file or share your bot token. If it leaks, reset it in the Developer Portal.
- Only members with **Manage Server** can create codes, settle tickets, view reports or delete data

## License

MIT
