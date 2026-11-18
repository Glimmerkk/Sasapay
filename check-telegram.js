// Optional local diagnostics: npm run check:telegram
// Uses your private bots.json. Never displays bot tokens.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const file = join(root, 'bots.json');
if (!existsSync(file) && !process.env.TELEGRAM_BOTS_JSON) {
  console.error('bots.json is missing. Copy bots.example.json to bots.json, insert a NEW bot token and your personal Telegram chat ID, and restart.');
  process.exitCode = 1;
} else {
  const bots = JSON.parse(process.env.TELEGRAM_BOTS_JSON || readFileSync(file, 'utf8'));
  for (const bot of bots) {
    const label = bot.name || 'Reviewer';
    if (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(String(bot.token || ''))) {
      console.error(`${label}: invalid or placeholder bot token`);
      process.exitCode = 1;
      continue;
    }
    try {
      const get = await fetch(`https://api.telegram.org/bot${bot.token}/getMe`, { signal: AbortSignal.timeout(7000) });
      const account = await get.json();
      if (!account.ok) throw new Error('Bad bot token: ' + account.description);
      console.log(`${label}: token OK (@${account.result.username})`);
      const result = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: bot.chatId, text: '✅ Promos Deal bot check succeeded. Your chat is configured for review notifications.' }),
        signal: AbortSignal.timeout(7000),
      });
      const response = await result.json();
      if (!response.ok) throw new Error('Cannot message the configured chat: ' + response.description);
      console.log(`${label}: message delivered successfully. Telegram approval messages are enabled.`);
    } catch (err) {
      console.error(`${label}: ${err.message}\nCheck that chatId is YOUR Telegram account/chat ID, not the bot ID. Open the bot, send /start, and verify its token.`);
      process.exitCode = 1;
    }
  }
}
