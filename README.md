# Wealthsimple OFX Export (maintained fork)

This repository maintains a fork of the original "Wealthsimple export transactions as CSV" userscript, modified to export transactions in OFX format and updated to keep working with Wealthsimple's frontend changes.

- Original script by: "eaglesemanation" — https://greasyfork.org/en/scripts/500403-wealthsimple-export-transactions-as-csv
- Modified by: Peter Kieser — adds OFX support, investment-account handling and reconciliation

This repo contains and maintains the OFX version of the userscript (`WealthsimpleOfxExport.js`).

## Overview

The userscript adds "Export Transactions as OFX" buttons to Wealthsimple's Activity and Account pages. It fetches your activity through Wealthsimple's GraphQL endpoints (the same ones the website uses) and generates one OFX file per account for import into personal finance software.

Features:
- Exports from the account activity view or the Activity feed, respecting the Activity page's account filter.
- Writes each account's real current value as the statement balance.
- Labels transfers with the other account's name and ID, and dividends, interest, fees and withholding tax with clear, rule-friendly memos.
- Uses payees like `Stock - ABC` / `Crypto - ABC` for trades and dividends.

### Investment accounts

Investment accounts (self-directed and managed) are exported in bank-statement format so budgeting apps can track them, with these additions:

- **Trades as memo only.** Buys and sells are exported with a 0.00 amount, with the details in the memo, so the cash stays "in" the account.
- **Monthly market gain/loss.** One entry per completed month (payee `Market gain` / `Market loss`) equal to the change in the account's value minus deposits, withdrawals and income that month. After each entry, the account balance matches Wealthsimple's month-end value to the cent. Entries have stable IDs, so re-exporting never duplicates them.
- **Registered vs non-registered labels.** Dividends, interest, fees, withholding tax and gains are tagged `(registered)` or `(non-registered)`, e.g. `Dividend (non-registered): ABC`, for automatic categorization.
- **Cost details for non-registered trades.** Per-share price and CAD total, plus the USD price and Wealthsimple's exchange rate for US-listed securities, e.g. `Buy 10 ABC @ 20.00 USD/sh, FX 1.400000 = 280.00 CAD (28.00 CAD/sh)`. Useful for tracking adjusted cost base.

## Installation

1. Install a userscript manager: Violentmonkey (recommended), Tampermonkey or Greasemonkey.
2. Install `WealthsimpleOfxExport.js` (open the raw file to get an install prompt, or paste it into a new script).
3. Disable automatic updates for the script if you installed an older version from Greasy Fork, so it isn't overwritten.
4. Open https://my.wealthsimple.com, go to Activity or an account page, and reload. The buttons appear near the page header.

## Usage

- Click **Last 2 Weeks**, **This Month** or **All**. One OFX file downloads per account.
- Run **All** once when setting up an account, then use shorter ranges for regular updates. Shorter ranges also include the most recent completed month's gain/loss entry.
- The **gear menu** has the settings:
  - **Swap memo/payee**: for apps that only show one of the two.
  - **Trades as memo only**: on by default; required for monthly gain/loss.
  - **Monthly market gain/loss**: on by default.
  - **Opening balance entry**: off by default. Adds the account's value before its earliest available transaction, for accounts you haven't tracked before.
  - **Run diagnostics**, **Log raw trade records**, **Capture site GraphQL requests**: debugging tools that write to the browser console.

### Reconciling

Each export prints to the browser console (F12):
- a per-account summary (transactions exported and skipped, balance, gap to balance), and
- for investment accounts, a month-by-month **reconciliation table**. After each month's gain/loss entry, your app's balance should equal the `appShouldShow` value.

If you already have older history in your app, the table's first row shows the balance your app must hold on the day before the import's history begins.

## Notes and limitations

- The script relies on Wealthsimple's frontend GraphQL API and your login session. If Wealthsimple changes its API, the script may stop working until updated.
- **The current month isn't booked** until it ends, so mid-month your app will differ from Wealthsimple's live balance by that month's market movement so far.
- **History may start partway through.** For some accounts, Wealthsimple's activity feed only returns records from a certain date (e.g. April 2023). Earlier transactions must come from your own records or statements.
- **Some older transfers have no amount** in Wealthsimple's data. They are exported as 0.00 with a note in the memo, and their value ends up in that month's gain/loss entry.
- **Dates use your computer's time zone.** Older records timestamped at midnight Toronto time may show one day earlier in western time zones.
- **Order details are cached** in your browser's storage for my.wealthsimple.com, so they're fetched only once. Nothing is sent anywhere other than Wealthsimple.
- Transaction types the script doesn't recognize are skipped and listed in the console. Please report them.

## Development / Contributions

Contributions are welcome: bug reports, fixes for Wealthsimple changes, new transaction types, or OFX mapping improvements. When contributing:
- Keep original attribution intact.
- If you modify code, add your own copyright line for your changes and retain the original MIT permission notice.
- For unrecognized transaction types, include the console output from **Log raw trade records** or the skipped-type warning, with account IDs and amounts removed.

## Changelog (high level)

- Converted export format from CSV to OFX; one file per account.
- Real account balances instead of 0.
- Investment accounts: memo-only trades, monthly market gain/loss entries, optional opening balance, reconciliation table.
- Registered / non-registered labels on dividends, interest, fees, withholding tax and gains.
- Per-share cost, USD price and exchange rate for non-registered trades.
- Support for managed-portfolio types (management fees, ETF rebates, non-resident tax, legacy transfers), cash dividends, stock-lending interest and bank deposits.
- Fixes: account filter on the Activity page, buy/sell direction, EFT withdrawals, accounts beyond the first 25, missing amounts, transaction ordering within a day.
- Diagnostics and debugging tools in the settings menu.

## License

This project (and the included script) is licensed under the MIT License.

The original script by eaglesemanation is likewise permissively licensed; this fork is a modified version maintained by Peter Kieser. The original attribution is preserved.

For full license text, see the LICENSE file included with this repository.

## Attribution

- Original script: eaglesemanation — https://greasyfork.org/en/scripts/500403-wealthsimple-export-transactions-as-csv
- OFX modifications and maintenance: Simon Trigona, Peter Kieser

If you republish or distribute this script, please keep the original attribution and the MIT permission notice intact.