require('dotenv').config();
const { Bot } = require('grammy');
const wol = require('wake_on_lan');
const { exec } = require('child_process');

// Create bot instance
const bot = new Bot(process.env.BOT_TOKEN);

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
    'Or just send me a message!'
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
