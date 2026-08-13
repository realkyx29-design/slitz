import { performance } from 'node:perf_hooks';

export const SERVICE_STATE = Object.freeze({
  WORKING: 'working',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
});

export const STATE_PRESENTATION = Object.freeze({
  [SERVICE_STATE.WORKING]: Object.freeze({ indicator: '✅', label: 'Working normally' }),
  [SERVICE_STATE.DEGRADED]: Object.freeze({ indicator: '🚦', label: 'Issues detected' }),
  [SERVICE_STATE.OFFLINE]: Object.freeze({ indicator: '❌', label: 'Offline / unavailable' }),
});

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_DEGRADED_PING_MS = 750;
const DEFAULT_CACHE_MS = 10_000;
const CLIENTS = new WeakMap();

// Every third-party API the bot reports on. Each entry needs an unauthenticated
// (or auth-gated, see `reachableStatuses`) probe URL; `statusUrl` is optional and
// points at the provider's public status feed where one exists.
const EXTERNAL_SERVICES = Object.freeze([
  Object.freeze({
    id: 'discord',
    name: 'Discord API',
    probeUrl: 'https://discord.com/api/v10/gateway',
    statusUrl: 'https://discordstatus.com/api/v2/status.json',
    statusFormat: 'statuspage',
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
  Object.freeze({
    id: 'github',
    name: 'GitHub API',
    probeUrl: 'https://api.github.com/meta',
    statusUrl: 'https://www.githubstatus.com/api/v2/status.json',
    statusFormat: 'statuspage',
    headers: Object.freeze({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }),
  }),
  Object.freeze({
    id: 'roblox',
    name: 'Roblox API',
    probeUrl: 'https://users.roblox.com/v1/users/1',
    // Roblox publishes its status feed via status.io, not Statuspage.
    statusUrl: 'https://4277980205320394.hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d',
    statusFormat: 'statusio',
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
  Object.freeze({
    id: 'openai',
    name: 'OpenAI API',
    probeUrl: 'https://api.openai.com/v1/models',
    statusUrl: 'https://status.openai.com/api/v2/status.json',
    statusFormat: 'statuspage',
    // /v1/models requires a bearer key, so an unauthenticated 401/403 still
    // proves the API itself is reachable.
    reachableStatuses: Object.freeze([401, 403]),
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
  Object.freeze({
    id: 'cloudflare',
    name: 'Cloudflare API',
    probeUrl: 'https://api.cloudflare.com/client/v4/',
    statusUrl: 'https://www.cloudflarestatus.com/api/v2/status.json',
    statusFormat: 'statuspage',
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
  Object.freeze({
    id: 'steam',
    name: 'Steam Web API',
    // GetServerInfo works without an API key; Valve has no public status feed.
    probeUrl: 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/',
    statusUrl: null,
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
  Object.freeze({
    id: 'google',
    name: 'Google APIs',
    probeUrl: 'https://www.googleapis.com/discovery/v1/apis',
    statusUrl: null,
    headers: Object.freeze({ Accept: 'application/json' }),
  }),
]);

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function cleanText(value, fallback = '', maxLength = 180) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function normalizePing(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function serviceResult({ id, name, state, pingMs = null, message, reason = null, httpStatus = null }) {
  const presentation = STATE_PRESENTATION[state] ?? STATE_PRESENTATION[SERVICE_STATE.OFFLINE];
  return {
    id,
    name,
    state,
    indicator: presentation.indicator,
    label: presentation.label,
    message: cleanText(message, presentation.label),
    pingMs: normalizePing(pingMs),
    reason,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
  };
}

function fallbackResult(id, name) {
  return serviceResult({
    id,
    name,
    state: SERVICE_STATE.OFFLINE,
    message: 'The check could not be completed.',
    reason: 'check_failed',
  });
}

/**
 * Perform one bounded HTTP request. Network failures and timeouts are returned
 * as data so one unavailable provider can never reject the complete snapshot.
 */
export async function timedFetch(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  parseJson = false,
  now = () => performance.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { kind: 'network_error', pingMs: null, reason: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const startedAt = now();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Slitz-API-Status/2.0',
        ...headers,
      },
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });

    let data = null;
    if (parseJson) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    } else {
      // Direct probes only need the status code. Cancel large response bodies so
      // repeated checks cannot hold sockets or download data unnecessarily.
      try {
        await response.body?.cancel();
      } catch {
        // A completed status response is still a valid probe if cleanup fails.
      }
    }

    return {
      kind: 'response',
      httpStatus: response.status,
      pingMs: normalizePing(now() - startedAt),
      data,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      kind: timedOut ? 'timeout' : 'network_error',
      pingMs: null,
      reason: timedOut ? 'timeout' : cleanText(error?.code, 'network_error', 48),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyProbe(definition, probe, degradedPingMs) {
  if (probe.kind === 'timeout') {
    return serviceResult({
      id: definition.id,
      name: definition.name,
      state: SERVICE_STATE.OFFLINE,
      message: 'The request timed out.',
      reason: 'timeout',
    });
  }

  if (probe.kind !== 'response') {
    return serviceResult({
      id: definition.id,
      name: definition.name,
      state: SERVICE_STATE.OFFLINE,
      message: 'The API could not be reached.',
      reason: 'network_error',
    });
  }

  const { httpStatus, pingMs } = probe;

  // Some providers only expose authenticated endpoints. A 401/403 without
  // credentials is still evidence the API itself is up, when the definition
  // declares those statuses as reachable.
  const authRequired = (definition.reachableStatuses ?? []).includes(httpStatus);
  const reachable = authRequired || (httpStatus >= 200 && httpStatus < 400);

  if (reachable) {
    if (pingMs !== null && pingMs >= degradedPingMs) {
      return serviceResult({
        id: definition.id,
        name: definition.name,
        state: SERVICE_STATE.DEGRADED,
        pingMs,
        message: 'The API is responding more slowly than expected.',
        reason: 'high_latency',
        httpStatus,
      });
    }

    return serviceResult({
      id: definition.id,
      name: definition.name,
      state: SERVICE_STATE.WORKING,
      pingMs,
      message: authRequired
        ? 'Reachable — the endpoint requires authentication.'
        : 'Working normally.',
      httpStatus,
    });
  }

  if (httpStatus === 408 || httpStatus >= 500) {
    return serviceResult({
      id: definition.id,
      name: definition.name,
      state: SERVICE_STATE.OFFLINE,
      pingMs,
      message: `The API returned HTTP ${httpStatus}.`,
      reason: 'server_error',
      httpStatus,
    });
  }

  return serviceResult({
    id: definition.id,
    name: definition.name,
    state: SERVICE_STATE.DEGRADED,
    pingMs,
    message: httpStatus === 429
      ? 'The API is online but rate limiting requests.'
      : `The API returned HTTP ${httpStatus}.`,
    reason: httpStatus === 429 ? 'rate_limited' : 'request_error',
    httpStatus,
  });
}

function interpretProviderStatus(payload, format = 'statuspage') {
  if (format === 'statusio') return interpretStatusIoStatus(payload);
  return interpretStatuspageStatus(payload);
}

function interpretStatuspageStatus(payload) {
  const indicator = cleanText(payload?.status?.indicator, '', 32).toLowerCase();
  const description = cleanText(payload?.status?.description, 'Provider reports an active incident.');

  if (!indicator || indicator === 'none') return null;

  if (['minor', 'major', 'critical', 'maintenance'].includes(indicator)) {
    return { reason: indicator === 'maintenance' ? 'maintenance' : 'provider_incident', description };
  }

  return null;
}

/**
 * status.io feeds (used by Roblox) expose `result.status_overall` with a
 * status code: 100 operational, 300 degraded performance, 400 partial service
 * disruption, 500 service disruption, 600 under maintenance.
 */
function interpretStatusIoStatus(payload) {
  const overall = payload?.result?.status_overall;
  const statusCode = Number(overall?.status_code);
  const description = cleanText(overall?.status, 'Provider reports an active incident.');

  // status.io codes: 100 operational, 300 degraded performance, 400 partial
  // service disruption, 500 service disruption, 600 under maintenance.
  if (!Number.isInteger(statusCode) || statusCode < 300) return null;

  const indicator = statusCode >= 600
    ? 'maintenance'
    : statusCode >= 500
      ? 'critical'
      : statusCode >= 400
        ? 'major'
        : 'minor';

  return { reason: indicator === 'maintenance' ? 'maintenance' : 'provider_incident', description };
}

async function checkExternalService(definition, options) {
  const [probe, providerStatus] = await Promise.all([
    timedFetch(definition.probeUrl, {
      ...options,
      headers: definition.headers,
    }),
    definition.statusUrl
      ? timedFetch(definition.statusUrl, {
        ...options,
        parseJson: true,
      })
      : Promise.resolve(null),
  ]);

  const directResult = classifyProbe(definition, probe, options.degradedPingMs);
  if (directResult.state !== SERVICE_STATE.WORKING || !providerStatus || providerStatus.kind !== 'response') {
    return directResult;
  }

  const incident = interpretProviderStatus(providerStatus.data, definition.statusFormat);
  if (!incident) return directResult;

  return serviceResult({
    id: definition.id,
    name: definition.name,
    state: SERVICE_STATE.DEGRADED,
    pingMs: directResult.pingMs,
    message: incident.description,
    reason: incident.reason,
    httpStatus: directResult.httpStatus,
  });
}

export function checkBotApi(client, { degradedPingMs = DEFAULT_DEGRADED_PING_MS } = {}) {
  const definition = { id: 'bot', name: 'Bot API' };

  try {
    if (!client?.isReady?.()) {
      return serviceResult({
        ...definition,
        state: SERVICE_STATE.OFFLINE,
        message: 'The bot is not connected to Discord.',
        reason: 'bot_not_ready',
      });
    }

    const pingMs = normalizePing(client?.ws?.ping);
    let databaseStatus = null;
    try {
      databaseStatus = client?.db?.getStatus?.() ?? null;
    } catch {
      databaseStatus = { isDegraded: true, degradedReason: 'Database health check failed' };
    }

    if (databaseStatus?.isDegraded) {
      return serviceResult({
        ...definition,
        state: SERVICE_STATE.DEGRADED,
        pingMs,
        message: cleanText(databaseStatus.degradedReason, 'The database is operating in degraded mode.'),
        reason: 'database_degraded',
      });
    }

    if (pingMs === null) {
      return serviceResult({
        ...definition,
        state: SERVICE_STATE.DEGRADED,
        message: 'The bot is online, but ping is temporarily unavailable.',
        reason: 'ping_unavailable',
      });
    }

    if (pingMs >= degradedPingMs) {
      return serviceResult({
        ...definition,
        state: SERVICE_STATE.DEGRADED,
        pingMs,
        message: 'The bot is online but experiencing high latency.',
        reason: 'high_latency',
      });
    }

    return serviceResult({
      ...definition,
      state: SERVICE_STATE.WORKING,
      pingMs,
      message: 'Working normally.',
    });
  } catch {
    return fallbackResult(definition.id, definition.name);
  }
}

function overallState(services) {
  if (services.some((service) => service.state === SERVICE_STATE.OFFLINE)) return 'outage';
  if (services.some((service) => service.state === SERVICE_STATE.DEGRADED)) return 'degraded';
  return 'operational';
}

function summaryFor(services) {
  return {
    overall: overallState(services),
    total: services.length,
    working: services.filter((service) => service.state === SERVICE_STATE.WORKING).length,
    degraded: services.filter((service) => service.state === SERVICE_STATE.DEGRADED).length,
    offline: services.filter((service) => service.state === SERVICE_STATE.OFFLINE).length,
  };
}

export function createApiStatusMonitor(client, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = boundedNumber(options.timeoutMs ?? process.env.STATUS_CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 30_000);
  const degradedPingMs = boundedNumber(options.degradedPingMs ?? process.env.STATUS_DEGRADED_PING_MS, DEFAULT_DEGRADED_PING_MS, 50, 30_000);
  const cacheMs = boundedNumber(options.cacheMs ?? process.env.STATUS_CACHE_MS, DEFAULT_CACHE_MS, 0, 60_000);
  const nowDate = options.nowDate ?? (() => new Date());
  const nowMs = options.nowMs ?? (() => Date.now());
  const perfNow = options.perfNow ?? (() => performance.now());

  let cachedSnapshot = null;
  let cachedUntil = 0;
  let pendingCheck = null;

  async function runChecks() {
    const startedAt = perfNow();
    const requestOptions = { fetchImpl, timeoutMs, degradedPingMs, now: perfNow };

    const checks = await Promise.allSettled([
      Promise.resolve().then(() => checkBotApi(client, { degradedPingMs })),
      ...EXTERNAL_SERVICES.map((definition) => checkExternalService(definition, requestOptions)),
    ]);

    const definitions = [
      { id: 'bot', name: 'Bot API' },
      ...EXTERNAL_SERVICES,
    ];

    const services = checks.map((check, index) => (
      check.status === 'fulfilled'
        ? check.value
        : fallbackResult(definitions[index].id, definitions[index].name)
    ));

    return {
      schemaVersion: 1,
      checkedAt: nowDate().toISOString(),
      durationMs: normalizePing(perfNow() - startedAt) ?? 0,
      refreshAfterMs: 30_000,
      summary: summaryFor(services),
      services,
    };
  }

  async function getSnapshot({ force = false } = {}) {
    const currentTime = nowMs();
    if (!force && cachedSnapshot && currentTime < cachedUntil) return cachedSnapshot;
    if (pendingCheck) return pendingCheck;

    pendingCheck = runChecks()
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedUntil = nowMs() + cacheMs;
        return snapshot;
      })
      .finally(() => {
        pendingCheck = null;
      });

    return pendingCheck;
  }

  return { getSnapshot };
}

export function getApiStatusMonitor(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) {
    throw new TypeError('A Discord client is required to create the API status monitor.');
  }

  if (!CLIENTS.has(client)) CLIENTS.set(client, createApiStatusMonitor(client));
  return CLIENTS.get(client);
}
