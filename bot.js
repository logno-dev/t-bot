require('dotenv').config();
const { createClient } = require('@libsql/client');
const { Bot } = require('grammy');
const crypto = require('crypto');
const wol = require('wake_on_lan');
const { exec } = require('child_process');

// Create bot instance
const bot = new Bot(process.env.BOT_TOKEN);

const databaseUrl = process.env.DATABASE_URL;
const databaseToken = process.env.DATABASE_TOKEN;
const portalBaseUrl = process.env.PORTAL_BASE_URL || 'https://your-portal.com';
const portalBotToken = process.env.PORTAL_BOT_API_TOKEN || 'replace-me';

if (!databaseUrl || !databaseToken) {
  throw new Error('DATABASE_URL and DATABASE_TOKEN must be set in the .env file');
}

const db = createClient({
  url: databaseUrl,
  authToken: databaseToken,
});

const WORDLE_HEADER_RE = /^Wordle\s+([\d,]+)\s+([1-6X])\/6\*?/i;
const WORDLE_BASE_DATE = new Date(Date.UTC(2021, 5, 19));

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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_link_tokens (
      telegram_user_id TEXT PRIMARY KEY NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
    );
  `);
  await db.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_tokens_token_idx ON telegram_link_tokens (token);'
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

  await ensureTelegramUser(user);

  const insertResult = await db.execute({
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
      ON CONFLICT(telegram_user_id, game_number) DO NOTHING;
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

  return Number(insertResult.rowsAffected ?? 0) > 0;
};

const wordleDayFromNumber = (gameNumber) => {
  const date = new Date(WORDLE_BASE_DATE.getTime());
  date.setUTCDate(date.getUTCDate() + gameNumber);
  return date.toISOString().slice(0, 10);
};

const fetchWordleAnswer = async (wordleDay) => {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available in this Node version');
  }

  const response = await fetch(`https://www.nytimes.com/svc/wordle/v2/${wordleDay}.json`);
  if (!response.ok) {
    throw new Error(`Wordle answer fetch failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!data?.solution) {
    throw new Error('Wordle answer was missing from response');
  }

  return String(data.solution).toLowerCase();
};

const awardPortalLetter = async ({ telegramUserId, wordleDay, answer, score }) => {
  if (!portalBaseUrl || !portalBotToken || portalBotToken === 'replace-me') {
    console.warn('Portal award skipped: PORTAL_BASE_URL or PORTAL_BOT_API_TOKEN not configured.');
    return;
  }

  const trimmedBase = portalBaseUrl.replace(/\/+$/, '');
  const response = await fetch(`${trimmedBase}/api/award`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bot-token': portalBotToken,
    },
    body: JSON.stringify({
      telegram_user_id: telegramUserId,
      wordle_day: wordleDay,
      answer,
      score,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('Portal award failed:', response.status, body);
  }
};

const ensureTelegramUser = async (user) => {
  const now = Math.floor(Date.now() / 1000);
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
};

const createLinkToken = async (user) => {
  const now = Math.floor(Date.now() / 1000);
  await ensureTelegramUser(user);

  const existing = await db.execute({
    sql: 'SELECT token FROM telegram_link_tokens WHERE telegram_user_id = ? LIMIT 1;',
    args: [String(user.id)],
  });

  if (existing.rows?.length) {
    const token = existing.rows[0].token;
    await db.execute({
      sql: 'UPDATE telegram_link_tokens SET updated_at = ? WHERE telegram_user_id = ?;',
      args: [now, String(user.id)],
    });
    return token;
  }

  const token = crypto.randomBytes(16).toString('hex');

  await db.execute({
    sql: `
      INSERT INTO telegram_link_tokens (telegram_user_id, token, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        token = excluded.token,
        updated_at = excluded.updated_at;
    `,
    args: [String(user.id), token, now, now],
  });

  return token;
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
    '/help - Show this help message\n' +
    '/about - Learn about this bot\n' +
    '/game - How to play the meta game\n' +
    '/link - Get a portal connection token\n' +
    'Or just send me a message, including Wordle results!'
  );
});

// About command
bot.command('about', (ctx) => {
  ctx.reply('I\'m a simple Telegram bot built with grammY framework. More features coming soon!');
});

// Game command
bot.command('game', (ctx) => {
  const trimmedBase = portalBaseUrl.replace(/\/+$/, '');
  ctx.reply(
    'Submit your Wordle results in this chat to earn letters in the meta game. ' +
      `Play your earned letters here: ${trimmedBase}`
  );
});

// Debug command
bot.command('debug', (ctx) => {
  const hasPortalUrl = Boolean(process.env.PORTAL_BASE_URL);
  const hasPortalToken = Boolean(process.env.PORTAL_BOT_API_TOKEN);
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const hasDatabaseToken = Boolean(process.env.DATABASE_TOKEN);

  ctx.reply(
    'Debug status:\n' +
      `PORTAL_BASE_URL set: ${hasPortalUrl}\n` +
      `PORTAL_BOT_API_TOKEN set: ${hasPortalToken}\n` +
      `DATABASE_URL set: ${hasDatabaseUrl}\n` +
      `DATABASE_TOKEN set: ${hasDatabaseToken}\n` +
      'Note: if Wordle messages are ignored in groups, disable bot privacy mode in BotFather.'
  );
});

// API test command
bot.command('apitest', async (ctx) => {
  if (!process.env.PORTAL_BASE_URL || !process.env.PORTAL_BOT_API_TOKEN) {
    ctx.reply('PORTAL_BASE_URL or PORTAL_BOT_API_TOKEN is not set.');
    return;
  }

  const trimmedBase = portalBaseUrl.replace(/\/+$/, '');

  try {
    const response = await fetch(`${trimmedBase}/api/award`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': portalBotToken,
      },
      body: JSON.stringify({ test: true }),
    });

    const bodyText = await response.text();
    ctx.reply(`API test status: ${response.status}\n${bodyText}`);
  } catch (error) {
    console.error('API test failed:', error);
    ctx.reply('API test failed. Check logs for details.');
  }
});

// Link command - provides portal connection token
bot.command('link', async (ctx) => {
  if (ctx.chat?.type !== 'private') {
    ctx.reply('Please DM me `/link` to get your connection token.', {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    const token = await createLinkToken(ctx.from);
    const portalBaseUrl = process.env.PORTAL_BASE_URL;
    if (portalBaseUrl) {
      const trimmedBase = portalBaseUrl.replace(/\/+$/, '');
      ctx.reply(`Use this link to connect your account:\n${trimmedBase}/connect?token=${token}`);
    } else {
      ctx.reply(`Your connection token is:\n${token}`);
    }
  } catch (error) {
    console.error('Failed to create link token:', error);
    ctx.reply('Sorry, I could not create a connection token right now. Please try again later.');
  }
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

    console.log('Git pull output:', stdout);

    exec('git diff --name-only HEAD@{1} HEAD', (diffError, diffStdout) => {
      if (diffError) {
        console.error('Git diff error:', diffError);
      }

      const changedFiles = diffStdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const needsInstall = changedFiles.some((file) =>
        ['package.json', 'pnpm-lock.yaml', 'package-lock.json'].includes(file)
      );

      const finishUpdate = (message) => {
        ctx.reply(`${message}\n\nRestarting bot...`);
        setTimeout(() => {
          console.log('Restarting process...');
          process.exit(0); // PM2 will automatically restart the bot
        }, 1000);
      };

      if (!needsInstall) {
        finishUpdate(`Git pull complete:\n${stdout}`);
        return;
      }

      ctx.reply('Dependencies changed. Installing packages...');
      exec('pnpm install', (installError, installStdout, installStderr) => {
        if (installError) {
          console.error('pnpm install error:', installError);
          exec('npm install', (npmError, npmStdout, npmStderr) => {
            if (npmError) {
              console.error('npm install error:', npmError);
              ctx.reply(`Dependency install failed:\n${installError.message}\n${npmError.message}`);
              return;
            }

            if (npmStderr) {
              console.log('npm install stderr:', npmStderr);
            }

            finishUpdate(`Git pull complete:\n${stdout}\n\nDependencies installed with npm.`);
          });
          return;
        }

        if (installStderr) {
          console.log('pnpm install stderr:', installStderr);
        }

        finishUpdate(`Git pull complete:\n${stdout}\n\nDependencies installed with pnpm.`);
      });
    });
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
      const inserted = await storeWordleResult(ctx, wordleResult);
      if (inserted) {
        const wordleDay = wordleDayFromNumber(wordleResult.gameNumber);
        const answer = await fetchWordleAnswer(wordleDay);
        const score = wordleResult.solved ? wordleResult.attempts : 'x';
        await awardPortalLetter({
          telegramUserId: String(ctx.from.id),
          wordleDay,
          answer,
          score,
        });
      }
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
