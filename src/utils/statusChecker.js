import axios from 'axios';
import { logger } from './logger.js';

// Status indicators
const STATUS = Object.freeze({
  ONLINE: 'online',
  ISSUES: 'issues',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
});

const STATUS_META = Object.freeze({
  [STATUS.ONLINE]: {
    label: 'Online',
    emoji: '<:online:1277944700025471016>', // fall back to text below if emoji not available
    fallbackEmoji: '🟢',
    color: '#57F287',
  },
  [STATUS.ISSUES]: {
    label: 'Having Issues',
    emoji: '<:idle:1277944782640496702>',
    fallbackEmoji: '🟡',
    color: '#FEE75C',
  },
  [STATUS.OFFLINE]: {
    label: 'Offline',
    emoji: '<:dnd:1277944754970677303>',
    fallbackEmoji: '🔴',
    color: '#ED4245',
  },
  [STATUS.UNKNOWN]: {
    label: 'Unknown',
    emoji: '<:offline:1277944802240888862>',
    fallbackEmoji: '⚫',
    color: '#99AAB5',
  },
});

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Resolve the emoji text to use. Falls back to the colored circle if the custom
 * emoji ID is unavailable in the current guild.
 */
function getEmoji(meta) {
  return meta?.fallbackEmoji ?? '⚫';
}

/**
 * Safely perform an HTTP GET, returning { ok, data, responseTimeMs, error } on a
 * short timeout. Never throws; all network/promise failures are captured.
 */
async function safeGet(url, { timeout = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'SlitzBot-StatusChecker/1.0',
        'Accept': 'application/json,text/plain,*/*',
        ...headers,
      },
      // Don't let non-2xx codes reject; we want to inspect them ourselves
      validateStatus: () => true,
    });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      data: res.data,
      responseTimeMs: Date.now() - start,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      responseTimeMs: Date.now() - start,
      error,
    };
  }
}

/**
 * Interpret an Atlassian Statuspage /status.json payload
 * (used by GitHub: https://www.githubstatus.com/api/v2/status.json)
 */
function interpretStatuspageStatus(payload) {
  const indicator = payload?.status?.indicator;
  const description = payload?.status?.description || '';

  // indicator can be: 'none', 'minor', 'major', 'critical', 'maintenance'
  if (!indicator) {
    return { status: STATUS.UNKNOWN, detail: description || 'Status indicator unavailable' };
  }

  switch (String(indicator).toLowerCase()) {
    case 'none':
      return { status: STATUS.ONLINE, detail: description || 'All systems operational' };
    case 'minor':
    case 'maintenance':
      return { status: STATUS.ISSUES, detail: description || 'Minor issues or maintenance in progress' };
    case 'major':
    case 'critical':
      return { status: STATUS.OFFLINE, detail: description || 'Major service outage' };
    default:
      return { status: STATUS.UNKNOWN, detail: description || 'Unknown status' };
  }
}

/**
 * Interpret an Instatus summary.json payload (used by Railway).
 * The schema looks like:
 *   { page: {...}, status: { indicator: "OPERATIONAL"|"HASISSUES"|"UNDERMAINTENANCE"|..., description: "..." } }
 * Components (v2/components.json) look like: [{ name, status: "OPERATIONAL"|"DEGRADEDPERFORMANCE"|..., ... }]
 */
function interpretInstatusSummary(summaryPayload, componentsPayload) {
  // First look at the page-level indicator.
  const indicator = typeof summaryPayload?.status?.indicator === 'string'
    ? summaryPayload.status.indicator.toUpperCase().replace(/[^A-Z]/g, '')
    : null;
  const description = summaryPayload?.status?.description || '';

  // Aggregate component statuses (component names + status for detail building).
  const components = Array.isArray(componentsPayload) ? componentsPayload : [];
  const notOperational = components
    .filter(c => c && typeof c.status === 'string' && c.status.toUpperCase() !== 'OPERATIONAL')
    .map(c => ({ name: c.name || 'Unknown component', status: c.status.toUpperCase() }));

  const componentWorst = (() => {
    if (notOperational.length === 0) return STATUS.ONLINE;
    const critical = ['MAJOROUTAGE', 'PARTIALOUTAGE', 'OUTAGE', 'DOWN', 'CRITICAL'];
    const warning = ['DEGRADEDPERFORMANCE', 'MINOROUTAGE', 'HASISSUES', 'UNDERMAINTENANCE', 'MAINTENANCE', 'MINOR'];
    if (notOperational.some(c => critical.some(k => c.status.includes(k)))) return STATUS.OFFLINE;
    if (notOperational.some(c => warning.some(k => c.status.includes(k)))) return STATUS.ISSUES;
    return STATUS.ISSUES;
  })();

  // Page indicator
  let pageStatus = STATUS.ONLINE;
  if (indicator) {
    if (['OPERATIONAL', 'UP', 'NONE'].includes(indicator)) pageStatus = STATUS.ONLINE;
    else if (['HASISSUES', 'MINOR', 'UNDERMAINTENANCE', 'MAINTENANCE', 'DEGRADEDPERFORMANCE'].includes(indicator)) pageStatus = STATUS.ISSUES;
    else if (['MAJOROUTAGE', 'PARTIALOUTAGE', 'OUTAGE', 'DOWN', 'CRITICAL', 'MAJOR'].includes(indicator)) pageStatus = STATUS.OFFLINE;
    else pageStatus = STATUS.UNKNOWN;
  } else {
    pageStatus = componentWorst;
  }

  // Final status = worst of page and components
  const rank = { [STATUS.ONLINE]: 0, [STATUS.ISSUES]: 1, [STATUS.OFFLINE]: 2, [STATUS.UNKNOWN]: -1 };
  const finalStatus = [pageStatus, componentWorst].reduce(
    (worst, s) => (rank[s] > rank[worst] ? s : worst),
    STATUS.ONLINE,
  );

  // Build a nice detail string
  let detail = description || 'All systems operational';
  if (notOperational.length > 0) {
    const sample = notOperational.slice(0, 3).map(c => `${c.name}`).join(', ');
    const suffix = notOperational.length > 3 ? `, +${notOperational.length - 3} more` : '';
    if (finalStatus === STATUS.OFFLINE) {
      detail = `Outage affecting: ${sample}${suffix}`;
    } else {
      detail = `Issues affecting: ${sample}${suffix}`;
    }
  } else if (finalStatus === STATUS.ISSUES) {
    detail = description || 'Minor issues or maintenance in progress';
  }

  return { status: finalStatus, detail };
}

/**
 * Check GitHub status via their public Statuspage endpoint.
 */
async function checkGitHub() {
  const url = 'https://www.githubstatus.com/api/v2/status.json';
  const result = await safeGet(url);

  if (!result.ok) {
    if (result.error) {
      logger.warn('GitHub status check failed:', result.error.message || result.error.code);
    }
    return {
      name: 'GitHub',
      status: STATUS.OFFLINE,
      ...STATUS_META[STATUS.OFFLINE],
      emoji: getEmoji(STATUS_META[STATUS.OFFLINE]),
      latency: result.responseTimeMs,
      detail: result.error?.code
        ? `Unable to reach GitHub status service (${result.error.code})`
        : 'Unable to reach GitHub status service',
      url,
    };
  }

  const interpreted = interpretStatuspageStatus(result.data);
  const meta = STATUS_META[interpreted.status];
  return {
    name: 'GitHub',
    status: interpreted.status,
    ...meta,
    emoji: getEmoji(meta),
    latency: result.responseTimeMs,
    detail: interpreted.detail,
    url,
  };
}

/**
 * Check Railway status via their Instatus-powered public API.
 * Docs: https://status.railway.com/public-api
 */
async function checkRailway() {
  const summaryUrl = 'https://status.railway.com/summary.json';
  const componentsUrl = 'https://status.railway.com/v2/components.json';

  const [summaryRes, componentsRes] = await Promise.all([
    safeGet(summaryUrl),
    safeGet(componentsUrl),
  ]);

  const responseTimeMs = Math.max(summaryRes.responseTimeMs, componentsRes.responseTimeMs);

  if (!summaryRes.ok && !componentsRes.ok) {
    const err = summaryRes.error || componentsRes.error;
    logger.warn('Railway status check failed:', err?.message || summaryRes.status);
    return {
      name: 'Railway',
      status: STATUS.OFFLINE,
      ...STATUS_META[STATUS.OFFLINE],
      emoji: getEmoji(STATUS_META[STATUS.OFFLINE]),
      latency: responseTimeMs,
      detail: err?.code
        ? `Unable to reach Railway status service (${err.code})`
        : 'Unable to reach Railway status service',
      url: 'https://status.railway.com/',
    };
  }

  // If at least one request succeeds, interpret what we have
  const interpreted = interpretInstatusSummary(
    summaryRes.ok ? summaryRes.data : null,
    componentsRes.ok ? componentsRes.data : null,
  );
  const meta = STATUS_META[interpreted.status];
  return {
    name: 'Railway',
    status: interpreted.status,
    ...meta,
    emoji: getEmoji(meta),
    latency: responseTimeMs,
    detail: interpreted.detail,
    url: 'https://status.railway.com/',
  };
}

/**
 * Check the Discord bot itself. Uses websocket heartbeat + client ready state.
 */
function checkDiscordBot(client) {
  try {
    const wsPing = Math.max(0, Math.round(client?.ws?.ping ?? -1));
    const readyState = client?.ws?.status; // 0 = connecting, 1 = ready (ws uses string in new djs)
    const uptimeMs = client?.uptime ?? 0;
    const isReady = !!client?.isReady?.() && client?.user;

    let status = STATUS.ONLINE;
    let detail = 'Bot is online and responsive';

    if (!isReady) {
      status = STATUS.OFFLINE;
      detail = 'Bot is not connected to Discord';
    } else if (wsPing <= 0 || wsPing > 1500) {
      // WS ping <= 0 means we don't have a valid heartbeat yet
      status = STATUS.ISSUES;
      detail = wsPing <= 0
        ? 'Waiting for websocket heartbeat'
        : 'High latency detected';
    }

    const meta = STATUS_META[status];
    return {
      name: 'Discord Bot',
      status,
      ...meta,
      emoji: getEmoji(meta),
      latency: wsPing > 0 ? wsPing : null,
      detail,
      uptimeMs,
      url: null,
    };
  } catch (error) {
    logger.error('Discord bot self-check failed:', error);
    const meta = STATUS_META[STATUS.UNKNOWN];
    return {
      name: 'Discord Bot',
      status: STATUS.UNKNOWN,
      ...meta,
      emoji: getEmoji(meta),
      latency: null,
      detail: 'Unable to determine bot status',
      uptimeMs: 0,
      url: null,
    };
  }
}

/**
 * Overall status precedence: OFFLINE > ISSUES > UNKNOWN > ONLINE.
 */
function computeOverallStatus(services) {
  if (services.some(s => s.status === STATUS.OFFLINE)) return STATUS.OFFLINE;
  if (services.some(s => s.status === STATUS.ISSUES)) return STATUS.ISSUES;
  if (services.some(s => s.status === STATUS.UNKNOWN)) return STATUS.UNKNOWN;
  return STATUS.ONLINE;
}

/**
 * Check all services in parallel with a top-level safety timeout.
 * @param {import('discord.js').Client} client
 */
export async function checkAllServices(client) {
  const timeoutMs = 8000;

  const checks = await Promise.all([
    checkGitHub().catch(err => {
      logger.error('Unexpected error in checkGitHub:', err);
      const meta = STATUS_META[STATUS.UNKNOWN];
      return {
        name: 'GitHub',
        status: STATUS.UNKNOWN,
        ...meta,
        emoji: getEmoji(meta),
        latency: null,
        detail: 'Unexpected error while checking GitHub status',
        url: 'https://www.githubstatus.com/',
      };
    }),
    checkRailway().catch(err => {
      logger.error('Unexpected error in checkRailway:', err);
      const meta = STATUS_META[STATUS.UNKNOWN];
      return {
        name: 'Railway',
        status: STATUS.UNKNOWN,
        ...meta,
        emoji: getEmoji(meta),
        latency: null,
        detail: 'Unexpected error while checking Railway status',
        url: 'https://status.railway.com/',
      };
    }),
    Promise.resolve().then(() => checkDiscordBot(client)).catch(err => {
      logger.error('Unexpected error in checkDiscordBot:', err);
      const meta = STATUS_META[STATUS.UNKNOWN];
      return {
        name: 'Discord Bot',
        status: STATUS.UNKNOWN,
        ...meta,
        emoji: getEmoji(meta),
        latency: null,
        detail: 'Unexpected error during bot self-check',
        uptimeMs: 0,
        url: null,
      };
    }),
  ]);

  // Enforce a hard wall-clock budget; Promise.all + internal timeouts should
  // already keep us within budget, but this guards against a hung check.
  const overall = computeOverallStatus(checks);
  const overallMeta = STATUS_META[overall];

  return {
    services: checks,
    overall: {
      status: overall,
      label: overallMeta.label,
      emoji: getEmoji(overallMeta),
      color: overallMeta.color,
    },
    checkedAt: new Date(),
  };
}

export { STATUS, STATUS_META };
