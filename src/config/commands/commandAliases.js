/**
 * Command Aliases Configuration
 * Maps shortened command names to their full command names
 */

/**
 * Command Aliases Configuration
 * Maps shortened command names to their full command names
 */

export const commandAliases = {
    // Economy
    'bal': 'balance',
    'money': 'balance',
    'cash': 'balance',
    'balance': 'balance',

    'dep': 'deposit',
    'deposit': 'deposit',
    'with': 'withdraw',
    'withdraw': 'withdraw',
    'work': 'work',
    'daily': 'daily',
    'gamble': 'gamble',
    'bet': 'gamble',
    'rob': 'rob',
    'crime': 'crime',
    'pay': 'pay',
    'give': 'pay',
    'send': 'pay',
    'beg': 'beg',
    'fish': 'fish',
    'mine': 'mine',
    'slut': 'slut',
    'economy': 'economy',
    'shop': 'shop',
    'buy': 'buy',
    'inventory': 'inventory',
    'inv': 'inventory',
    'items': 'inventory',
    'shop-config': 'shop-config',
    'shopconfig': 'shop-config',

    'eleaderboard': 'economy-leaderboard',
    'elb': 'economy-leaderboard',
    'rich': 'economy-leaderboard',
    'richest': 'economy-leaderboard',
    'economy-leaderboard': 'economy-leaderboard',
    'economyleaderboard': 'economy-leaderboard',

    // Core
    'ping': 'ping',
    'help': 'help',
    'h': 'help',
    'info': 'help',
    'commands': 'commands',
    'cmds': 'commands',
    'configwizard': 'config-wizard',
    'config-wizard': 'config-wizard',
    'config': 'config-wizard',
    'wizard': 'config-wizard',
    'stats': 'stats',
    'botstats': 'stats',
    'support': 'support',
    'uptime': 'uptime',

    // Moderation
    'ban': 'ban',
    'kick': 'kick',
    'mute': 'timeout',
    'timeout': 'timeout',
    'warn': 'warn',
    'warnings': 'warnings',
    'clear': 'purge',
    'purge': 'purge',
    'untimeout': 'untimeout',
    'unmute': 'untimeout',
    'unban': 'unban',
    'lock': 'lock',
    'unlock': 'unlock',
    'say': 'say',
    'dm': 'dm',
    'cases': 'cases',
    'massban': 'mass-ban',
    'mass-ban': 'mass-ban',
    'masskick': 'mass-kick',
    'mass-kick': 'mass-kick',
    'usernotes': 'user-notes',
    'user-notes': 'user-notes',
    'notes': 'user-notes',

    // Leveling
    'rank': 'rank',
    'lvl': 'rank',
    'xp': 'rank',
    'level': 'level',
    'leaderboard': 'level-leaderboard',
    'level-leaderboard': 'level-leaderboard',
    'levelleaderboard': 'level-leaderboard',
    'lb': 'level-leaderboard',
    'top': 'level-leaderboard',
    'levels': 'level-leaderboard',
    'leveladd': 'level-add',
    'level-add': 'level-add',
    'levelremove': 'level-remove',
    'level-remove': 'level-remove',
    'levelset': 'level-set',
    'level-set': 'level-set',

    // Utility & User
    'user': 'user-info',
    'userinfo': 'user-info',
    'user-info': 'user-info',
    'whois': 'user-info',
    'ui': 'user-info',
    'avatar': 'avatar',
    'pfp': 'avatar',
    'icon': 'avatar',
    'banner': 'banner',
    'firstmsg': 'first-message',
    'first-message': 'first-message',
    'firstmessage': 'first-message',
    'serverinfo': 'server-info',
    'server-info': 'server-info',
    'si': 'server-info',
    'weather': 'weather',
    'todo': 'todo',
    'report': 'report',
    'wipedata': 'wipe-data',
    'wipe-data': 'wipe-data',

    // Birthday
    'birthday': 'birthday',
    'bd': 'birthday',
    'bday': 'birthday',
    'b': 'birthday',

    // Fun
    'flip': 'coin-flip',
    'coin': 'coin-flip',
    'coinflip': 'coin-flip',
    'coin-flip': 'coin-flip',
    'roll': 'dice-roll',
    'dice': 'dice-roll',
    'diceroll': 'dice-roll',
    'dice-roll': 'dice-roll',
    'fight': 'fight',
    'count': 'counting',
    'counting': 'counting',

    // Giveaway
    'gcreate': 'giveaway-create',
    'gstart': 'giveaway-create',
    'giveaway-create': 'giveaway-create',
    'giveawaycreate': 'giveaway-create',
    'gend': 'giveaway-end',
    'gstop': 'giveaway-end',
    'giveaway-end': 'giveaway-end',
    'giveawayend': 'giveaway-end',
    'gdelete': 'giveaway-delete',
    'giveaway-delete': 'giveaway-delete',
    'giveawaydelete': 'giveaway-delete',
    'greroll': 'giveaway-reroll',
    'groll': 'giveaway-reroll',
    'giveaway-reroll': 'giveaway-reroll',
    'giveawayreroll': 'giveaway-reroll',

    // Ticket
    'ticket': 'ticket',
    't': 'ticket',
    'new': 'ticket',
    'claim': 'claim',
    'close': 'close',
    'priority': 'priority',

    // Verification
    'verify': 'verify',
    'ver': 'verify',
    'verification': 'verification',
    'vadmin': 'verification',
    'autoverify': 'auto-verify',
    'auto-verify': 'auto-verify',
    'av': 'auto-verify',

    // Welcome
    'welcome': 'welcome',
    'greet': 'greet',
    'goodbye': 'goodbye',
    'autorole': 'auto-role',
    'auto-role': 'auto-role',

    // Tools
    'calc': 'calculate',
    'math': 'calculate',
    'calculate': 'calculate',
    'countdown': 'countdown',
    'timer': 'countdown',
    'embedbuilder': 'embed-builder',
    'embed-builder': 'embed-builder',
    'embed': 'embed-builder',
    'generatepassword': 'generate-password',
    'generate-password': 'generate-password',
    'genpass': 'generate-password',
    'password': 'generate-password',
    'hexcolor': 'hex-color',
    'hex-color': 'hex-color',
    'color': 'hex-color',
    'poll': 'poll',
    'randomuser': 'random-user',
    'random-user': 'random-user',
    'randuser': 'random-user',
    'shorten': 'shorten-url',
    'shorten-url': 'shorten-url',
    'shorturl': 'shorten-url',
    'time': 'time',
    'unixtime': 'unix-time',
    'unix-time': 'unix-time',
    'timestamp': 'unix-time',
    'baseconvert': 'base-convert',
    'base-convert': 'base-convert',

    // Server Stats
    'serverstats': 'server-stats',
    'server-stats': 'server-stats',
    'ss': 'server-stats',
    'sstats': 'server-stats',

    // Reaction Roles
    'rr': 'reaction-roles',
    'reactionroles': 'reaction-roles',
    'reactroles': 'reaction-roles',
    'reaction-roles': 'reaction-roles',

    // Join to Create
    'jtc': 'join-to-create',
    'jointocreate': 'join-to-create',
    'join-to-create': 'join-to-create',

    // Music
    'nowplaying': 'now-playing',
    'now-playing': 'now-playing',
    'np': 'now-playing',
    'now': 'now-playing',
    'play': 'play',
    'join': 'join',
    'music': 'music',
    'queue': 'queue',

    // Community
    'app-admin': 'application-admin',
    'application-admin': 'application-admin',
    'apply': 'apply',

    // Search
    'search': 'search',
    'logging': 'logging',
};

export const subcommandAliases = {
    'l': 'list',
    'ls': 'list',
    's': 'set',
    'i': 'info',
    'r': 'remove',
    'rm': 'remove',
    'del': 'remove',
    'n': 'next',
    'sc': 'setchannel',

    'a': 'add',
    'c': 'complete',
    'done': 'complete',
    'd': 'complete',

    'start': 'create',
    'stop': 'end',
    'roll': 'reroll',

    'add': 'add',
    'remove': 'remove',
    'list': 'list',
};

/**
 * Resolve a command alias to its full command name
 * @param {string} commandName - The command name (could be an alias)
 * @returns {string} - The full command name, or the original if not an alias
 */
export function resolveCommandAlias(commandName) {
    const normalized = commandName.toLowerCase();
    return commandAliases[normalized] || commandName;
}

/**
 * Resolve a subcommand alias to its full subcommand name
 * @param {string} subcommandName - The subcommand name (could be an alias)
 * @returns {string} - The full subcommand name, or the original if not an alias
 */
export function resolveSubcommandAlias(subcommandName) {
    const normalized = subcommandName.toLowerCase();
    return subcommandAliases[normalized] || subcommandName;
}
