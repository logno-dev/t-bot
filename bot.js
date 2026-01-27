require('dotenv').config();
const { createClient } = require('@libsql/client');
const { Bot } = require('grammy');
const wol = require('wake_on_lan');
const { exec } = require('child_process');

// Create bot instance
const bot = new Bot(process.env.BOT_TOKEN);

const databaseUrl = process.env.DATABASE_URL;
const databaseToken = process.env.DATABASE_TOKEN;

if (!databaseUrl || !databaseToken) {
  throw new Error('DATABASE_URL and DATABASE_TOKEN must be set in the .env file');
}

const db = createClient({
  url: databaseUrl,
  authToken: databaseToken,
});

const WORDLE_HEADER_RE = /^Wordle\s+([\d,]+)\s+([1-6X])\/6/i;

const ensureSchema = async () => {
  await db.execute('PRAGMA foreign_keys = ON;');
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_users (
      telegram_user_id TEXT PRIMARY KEY NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_wordle_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      telegram_user_id TEXT NOT NULL,
      game_number INTEGER NOT NULL,
      attempts INTEGER,
      solved INTEGER NOT NULL,
      pattern TEXT,
      share_text TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      UNIQUE(telegram_user_id, game_number),
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
    );
  `);
  await db.execute(
    'CREATE INDEX IF NOT EXISTS telegram_wordle_results_game_number_idx ON telegram_wordle_results (game_number);'
  );
};

const parseWordleResult = (text) => {
  const lines = text.trim().split(/\r?\n/);
  const match = lines[0]?.match(WORDLE_HEADER_RE);

  if (!match) return null;

  const gameNumber = Number.parseInt(match[1].replace(/,/g, ''), 10);
  const attemptsToken = match[2].toUpperCase();
  const solved = attemptsToken !== 'X';
  const attempts = solved ? Number.parseInt(attemptsToken, 10) : null;
  const patternLines = lines.slice(1).filter(Boolean);
  const pattern = patternLines.length ? patternLines.join('\n') : null;

  if (!Number.isFinite(gameNumber)) return null;

  return {
    gameNumber,
    attempts,
    solved,
    pattern,
    shareText: text.trim(),
  };
};

const storeWordleResult = async (ctx, result) => {
  const now = Math.floor(Date.now() / 1000);
  const user = ctx.from;

  await db.execute({
    sql: `
      INSERT INTO telegram_users (telegram_user_id, username, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at;
    `,
    args: [
      String(user.id),
      user.username ?? null,
      user.first_name ?? null,
      user.last_name ?? null,
      now,
      now,
    ],
  });

  await db.execute({
    sql: `
      INSERT INTO telegram_wordle_results (
        telegram_user_id,
        game_number,
        attempts,
        solved,
        pattern,
        share_text,
        reported_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id, game_number) DO UPDATE SET
        attempts = excluded.attempts,
        solved = excluded.solved,
        pattern = excluded.pattern,
        share_text = excluded.share_text,
        reported_at = excluded.reported_at;
    `,
    args: [
      String(user.id),
      result.gameNumber,
      result.attempts,
      result.solved ? 1 : 0,
      result.pattern,
      result.shareText,
      now,
    ],
  });
};

// Start command
bot.command('start', (ctx) => {
  const userId = ctx.from.id;
  ctx.reply(`Hello! Welcome to the bot. How can I help you today?\n\nYour Telegram User ID is: ${userId}`);
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    'Here are some things you can try:\n' +
    '/start - Start the bot\n' +
    '/help - Show this help message\n' +
    '/about - Learn about this bot\n' +
    '/wake - Send Wake-on-LAN magic packet (authorized only)\n' +
    '/update - Pull latest code and restart bot (authorized only)\n' +
    'Or just send me a message, including Wordle results!'
  );
});

// About command
bot.command('about', (ctx) => {
  ctx.reply('I\'m a simple Telegram bot built with grammY framework. More features coming soon!');
});

// Wake-on-LAN command
bot.command('wake', (ctx) => {
  const authorizedUserId = process.env.AUTHORIZED_USER_ID;
  const userId = ctx.from.id.toString();

  // Check if user is authorized
  if (authorizedUserId && userId !== authorizedUserId) {
    ctx.reply('Unauthorized: You do not have permission to use this command.');
    console.log(`Unauthorized wake attempt from user ID: ${userId}`);
    return;
  }

  const macAddress = process.env.TARGET_MAC_ADDRESS;

  if (!macAddress) {
    ctx.reply('Error: MAC address not configured in .env file');
    return;
  }

  wol.wake(macAddress, (error) => {
    if (error) {
      ctx.reply(`Failed to send magic packet: ${error.message}`);
      console.error('WOL Error:', error);
    } else {
      ctx.reply(`Magic packet sent to ${macAddress}!`);
      console.log(`Magic packet sent to ${macAddress} by user ${userId}`);
    }
  });
});

// Update command - pulls latest code and restarts
bot.command('update', (ctx) => {
  const authorizedUserId = process.env.AUTHORIZED_USER_ID;
  const userId = ctx.from.id.toString();

  // Check if user is authorized
  if (authorizedUserId && userId !== authorizedUserId) {
    ctx.reply('Unauthorized: You do not have permission to use this command.');
    console.log(`Unauthorized update attempt from user ID: ${userId}`);
    return;
  }

  ctx.reply('Updating bot... Pulling latest code from git.');
  console.log(`Update initiated by user ${userId}`);

  exec('git pull', (error, stdout, stderr) => {
    if (error) {
      ctx.reply(`Git pull failed: ${error.message}`);
      console.error('Git pull error:', error);
      return;
    }

    if (stderr) {
      console.log('Git stderr:', stderr);
    }

    ctx.reply(`Git pull complete:\n${stdout}\n\nRestarting bot...`);
    console.log('Git pull output:', stdout);

    // Give time for the message to be sent before exiting
    setTimeout(() => {
      console.log('Restarting process...');
      process.exit(0); // PM2 will automatically restart the bot
    }, 1000);
  });
});

// Echo any text message
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;

  // Skip if it's a command
  if (text.startsWith('/')) return;

  const wordleResult = parseWordleResult(text);
  if (wordleResult) {
    try {
      await storeWordleResult(ctx, wordleResult);
      const attemptText = wordleResult.solved
        ? `${wordleResult.attempts}/6`
        : 'X/6';
      ctx.reply(`Saved your Wordle ${wordleResult.gameNumber} result (${attemptText}).`);
    } catch (error) {
      console.error('Failed to save Wordle result:', error);
      ctx.reply('Sorry, I could not save that Wordle result. Please try again later.');
    }
    return;
  }

  // Simple responses based on keywords
  if (text.toLowerCase().includes('hello') || text.toLowerCase().includes('hi')) {
    ctx.reply('Hey there! How are you doing?');
  } else if (text.toLowerCase().includes('how are you')) {
    ctx.reply('I\'m doing great, thanks for asking! How about you?');
  } else if (text.toLowerCase().includes('bye')) {
    ctx.reply('Goodbye! Have a great day!');
  } else if (text.toLowerCase().includes('what is the meaning of life')) {
    ctx.reply('42');
  } else {
    ctx.reply(`You said: ${text}`);
  }
});

// Error handling
bot.catch((err) => {
  console.error('Error occurred:', err);
});

// Start the bot
const startBot = async () => {
  try {
    await ensureSchema();
    await bot.start();
    console.log('Bot is running...');
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
};

startBot();
