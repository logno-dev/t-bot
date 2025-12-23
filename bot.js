require('dotenv').config();
const { Bot } = require('grammy');

// Create bot instance
const bot = new Bot(process.env.BOT_TOKEN);

// Start command
bot.command('start', (ctx) => {
  ctx.reply('Hello! Welcome to the bot. How can I help you today?');
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    'Here are some things you can try:\n' +
    '/start - Start the bot\n' +
    '/help - Show this help message\n' +
    '/about - Learn about this bot\n' +
    'Or just send me a message!'
  );
});

// About command
bot.command('about', (ctx) => {
  ctx.reply('I\'m a simple Telegram bot built with grammY framework. More features coming soon!');
});

// Echo any text message
bot.on('message:text', (ctx) => {
  const text = ctx.message.text;
  
  // Skip if it's a command
  if (text.startsWith('/')) return;
  
  // Simple responses based on keywords
  if (text.toLowerCase().includes('hello') || text.toLowerCase().includes('hi')) {
    ctx.reply('Hey there! How are you doing?');
  } else if (text.toLowerCase().includes('how are you')) {
    ctx.reply('I\'m doing great, thanks for asking! How about you?');
  } else if (text.toLowerCase().includes('bye')) {
    ctx.reply('Goodbye! Have a great day!');
  } else {
    ctx.reply(`You said: ${text}`);
  }
});

// Error handling
bot.catch((err) => {
  console.error('Error occurred:', err);
});

// Start the bot
bot.start();
console.log('Bot is running...');
