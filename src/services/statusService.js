import { performance } from 'node:perf_hooks';
import axios from 'axios';

const REQUEST_TIMEOUT_MS = 8000;
const DEGRADED_LATENCY_MS = 600;

const DEFAULTS = {
  discord: {
    url: 'https://discord.com/api/v10/gateway',
    method: 'GET',
    label: 'Discord API',
  },
  github: {
    url: 'https://api.github.com/zen',
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Slitz-Status-Checker' },
    validateStatus: (status) => status >= 200 && status < 500,
    label: 'GitHub API',
  },
};

async function timedRequest(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await axios({
      url: options.url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.data,
      timeout: REQUEST_TIMEOUT_MS,
      signal: controller.signal,
      validateStatus: options.validateStatus || (() => true),
    });
    const latency = Math.round(performance.now() - start);
    clearTimeout(timeout);
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latency,
      body: res.data,
    };
  } catch (err) {
    clearTimeout(timeout);
    const latency = Math.round(performance.now() - start);
    if (err.code === 'ECONNABORTED' || err.name === 'CanceledError' || err.name === 'AbortError') {
      return { ok: false, status: null, latency, error: 'timeout', message: 'Request timed out' };
    }
    return {
      ok: false,
      status: err.response?.status || null,
      latency,
      error: err.code || 'network_error',
      message: err.message,
    };
  }
}

export async function checkBotApi(bot) {
  const start = performance.now();
  try {
    const readyState = !!bot?.isReady?.();
    const dbStatus = bot?.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
    const latency = Math.round(performance.now() - start);

    // Internal round-trip: also hit our own /health endpoint for a real HTTP round-trip
    // But that requires knowing the port; the in-process check is sufficient and faster.
    let httpLatency = latency;
    const configuredPort = Number(bot?.config?.api?.port || process.env.PORT || 3000);
    try {
      const t0 = performance.now();
      await axios.get(`http://127.0.0.1:${configuredPort}/health`, { timeout: 3000 });
      httpLatency = Math.round(performance.now() - t0);
    } catch {
      // fall back to process-level latency
      httpLatency = latency;
    }

    if (!readyState) {
      return {
        name: 'Bot API',
        status: 'offline',
        icon: '❌',
        detail: 'Offline',
        ping: null,
        degradedReason: 'Client not ready',
      };
    }
    if (dbStatus.isDegraded) {
      return {
        name: 'Bot API',
        status: 'degraded',
        icon: '🚦',
        detail: 'Issues Detected',
        ping: httpLatency,
        degradedReason: dbStatus.degradedReason || 'Database degraded',
      };
    }
    return {
      name: 'Bot API',
      status: 'ok',
      icon: '✅',
      detail: 'Working normally',
      ping: httpLatency,
    };
  } catch (err) {
    return {
      name: 'Bot API',
      status: 'offline',
      icon: '❌',
      detail: 'Unavailable',
      ping: null,
      error: err.message,
    };
  }
}

export async function checkDiscordApi() {
  const result = await timedRequest(DEFAULTS.discord);
  return classify('Discord API', result);
}

export async function checkGitHubApi() {
  const result = await timedRequest(DEFAULTS.github);
  // GitHub zen endpoint returns 200 with a short string. 4xx means reachable but rate-limited/blocked.
  return classify('GitHub API', result);
}

function classify(name, result) {
  if (result.error === 'timeout') {
    return { name, status: 'offline', icon: '❌', detail: 'Unavailable', ping: result.latency, error: 'Timeout' };
  }
  if (!result.ok && result.status === null) {
    return { name, status: 'offline', icon: '❌', detail: 'Unavailable', ping: null, error: result.message };
  }
  if (result.status >= 500 || (result.status && result.status >= 400 && result.status !== 429)) {
    // 5xx = server-side issues = degraded (we can reach it, but it's misbehaving)
    // 4xx (other than 429 rate limit) usually means blocked/auth error → degraded
    return {
      name,
      status: 'degraded',
      icon: '🚦',
      detail: 'Issues Detected',
      ping: result.latency,
      httpStatus: result.status,
    };
  }
  if (result.status === 429) {
    return {
      name,
      status: 'degraded',
      icon: '🚦',
      detail: 'Issues Detected',
      ping: result.latency,
      httpStatus: result.status,
      degradedReason: 'Rate limited',
    };
  }
  if (result.latency >= DEGRADED_LATENCY_MS) {
    return {
      name,
      status: 'degraded',
      icon: '🚦',
      detail: 'Slow response',
      ping: result.latency,
      httpStatus: result.status,
    };
  }
  return {
    name,
    status: 'ok',
    icon: '✅',
    detail: 'Working normally',
    ping: result.latency,
    httpStatus: result.status,
  };
}

export async function getAllStatuses(bot) {
  const startedAt = Date.now();
  const [botApi, discordApi, githubApi] = await Promise.all([
    checkBotApi(bot).catch((e) => ({ name: 'Bot API', status: 'offline', icon: '❌', detail: 'Unavailable', ping: null, error: e.message })),
    checkDiscordApi().catch((e) => ({ name: 'Discord API', status: 'offline', icon: '❌', detail: 'Unavailable', ping: null, error: e.message })),
    checkGitHubApi().catch((e) => ({ name: 'GitHub API', status: 'offline', icon: '❌', detail: 'Unavailable', ping: null, error: e.message })),
  ]);

  const services = [botApi, discordApi, githubApi];
  const overallStatus = services.every((s) => s.status === 'ok')
    ? 'operational'
    : services.some((s) => s.status === 'offline')
      ? 'major_outage'
      : 'degraded';

  return {
    services,
    summary: {
      overall: overallStatus,
      total: services.length,
      operational: services.filter((s) => s.status === 'ok').length,
      degraded: services.filter((s) => s.status === 'degraded').length,
      offline: services.filter((s) => s.status === 'offline').length,
    },
    timestamp: new Date().toISOString(),
    checkDurationMs: Date.now() - startedAt,
  };
}
