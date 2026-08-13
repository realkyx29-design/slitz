(() => {
  'use strict';

  const STATUS_ENDPOINT = '/api/status';
  const DEFAULT_REFRESH_MS = 30_000;
  const RETRY_MS = 10_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const EXPECTED_SERVICES = Object.freeze({
    bot: 'Bot API',
    discord: 'Discord API',
    github: 'GitHub API',
    roblox: 'Roblox API',
    openai: 'OpenAI API',
    cloudflare: 'Cloudflare API',
    steam: 'Steam Web API',
    google: 'Google APIs',
  });
  const STATE_UI = Object.freeze({
    working: Object.freeze({ indicator: '✅', label: 'Working normally' }),
    degraded: Object.freeze({ indicator: '🚦', label: 'Issues detected' }),
    offline: Object.freeze({ indicator: '❌', label: 'Offline / unavailable' }),
  });

  const overview = document.getElementById('overview');
  const overallIcon = document.getElementById('overall-icon');
  const overallTitle = document.getElementById('overall-title');
  const overallDetail = document.getElementById('overall-detail');
  const lastUpdated = document.getElementById('last-updated');
  const countdown = document.getElementById('refresh-countdown');
  const refreshButton = document.getElementById('refresh-button');
  const notice = document.getElementById('status-notice');
  const servicesSection = document.getElementById('services');

  let refreshTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = null;
  let refreshInFlight = false;
  let hasSuccessfulSnapshot = false;

  function validDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function normalizedPing(value) {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.services)) {
      throw new Error('Invalid status response');
    }

    const services = payload.services.map((service) => {
      if (!service || typeof service !== 'object') throw new Error('Invalid service response');
      if (!Object.hasOwn(EXPECTED_SERVICES, service.id)) throw new Error('Unexpected service response');
      if (!Object.hasOwn(STATE_UI, service.state)) throw new Error('Invalid service state');

      return {
        id: service.id,
        name: EXPECTED_SERVICES[service.id],
        state: service.state,
        pingMs: normalizedPing(service.pingMs),
        message: typeof service.message === 'string' && service.message.trim()
          ? service.message.trim().slice(0, 180)
          : STATE_UI[service.state].label,
      };
    });

    const ids = new Set(services.map((service) => service.id));
    if (services.length !== 3 || ids.size !== 3 || Object.keys(EXPECTED_SERVICES).some((id) => !ids.has(id))) {
      throw new Error('Incomplete status response');
    }

    const checkedAt = validDate(payload.checkedAt);
    if (!checkedAt) throw new Error('Invalid check timestamp');

    const refreshAfterMs = Number.isFinite(payload.refreshAfterMs)
      ? Math.min(60_000, Math.max(15_000, payload.refreshAfterMs))
      : DEFAULT_REFRESH_MS;

    return { services, checkedAt, refreshAfterMs };
  }

  function deriveOverall(services) {
    const offline = services.filter((service) => service.state === 'offline').length;
    const degraded = services.filter((service) => service.state === 'degraded').length;

    if (offline > 0) {
      return {
        state: 'outage',
        icon: '❌',
        title: 'Service outage detected',
        detail: `${offline} ${offline === 1 ? 'service is' : 'services are'} currently unavailable.`,
      };
    }

    if (degraded > 0) {
      return {
        state: 'degraded',
        icon: '🚦',
        title: 'Some services are degraded',
        detail: `${degraded} ${degraded === 1 ? 'service is' : 'services are'} online but experiencing issues.`,
      };
    }

    return {
      state: 'operational',
      icon: '✅',
      title: 'All systems operational',
      detail: 'The bot and every connected API are working normally.',
    };
  }

  function formatCheckedTime(date) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  }

  function renderService(service) {
    const card = document.getElementById(`service-${service.id}`);
    const ui = STATE_UI[service.state];
    const pingText = service.pingMs === null ? 'Unavailable' : `${service.pingMs}ms`;
    const statement = service.pingMs === null
      ? `${ui.indicator} ${service.name} — ${ui.label}`
      : `${ui.indicator} ${service.name} — Ping: ${service.pingMs}ms`;

    card.dataset.state = service.state;
    card.classList.remove('is-stale');
    card.querySelector('[data-role="indicator"]').textContent = ui.indicator;
    card.querySelector('[data-role="state-label"]').textContent = ui.label;
    card.querySelector('[data-role="status-statement"]').textContent = statement;
    card.querySelector('[data-role="ping"]').textContent = pingText;
    card.querySelector('[data-role="message"]').textContent = service.message;
    card.setAttribute('aria-label', statement);
  }

  function renderSnapshot(snapshot) {
    snapshot.services.forEach(renderService);

    const overall = deriveOverall(snapshot.services);
    overview.dataset.state = overall.state;
    overview.classList.remove('is-stale');
    overallIcon.textContent = overall.icon;
    overallTitle.textContent = overall.title;
    overallDetail.textContent = overall.detail;
    lastUpdated.textContent = formatCheckedTime(snapshot.checkedAt);
    lastUpdated.dateTime = snapshot.checkedAt.toISOString();
    servicesSection.setAttribute('aria-busy', 'false');
    notice.hidden = true;
    hasSuccessfulSnapshot = true;
  }

  function renderFailure() {
    servicesSection.setAttribute('aria-busy', 'false');
    notice.hidden = false;

    if (hasSuccessfulSnapshot) {
      overview.classList.add('is-stale');
      overallTitle.textContent = 'Live update delayed';
      overallDetail.textContent = 'The last successful results remain visible while we retry.';
      notice.textContent = 'The status feed did not respond. Showing the last successful check; another update will be attempted automatically.';
      document.querySelectorAll('.service-card').forEach((card) => card.classList.add('is-stale'));
      return;
    }

    overview.dataset.state = 'error';
    overallIcon.textContent = '—';
    overallTitle.textContent = 'Live status unavailable';
    overallDetail.textContent = 'No service has been marked offline because the status feed itself could not be reached.';
    lastUpdated.textContent = 'No successful check';
    notice.textContent = 'Unable to load live status. Retrying automatically; the service cards will update when verified results are available.';

    Object.entries(EXPECTED_SERVICES).forEach(([id, name]) => {
      const card = document.getElementById(`service-${id}`);
      card.dataset.state = 'loading';
      card.querySelector('[data-role="indicator"]').textContent = '—';
      card.querySelector('[data-role="state-label"]').textContent = 'Status unavailable';
      card.querySelector('[data-role="status-statement"]').textContent = `${name} — Status unavailable`;
      card.querySelector('[data-role="ping"]').textContent = '—';
      card.querySelector('[data-role="message"]').textContent = 'Waiting for a verified response.';
    });
  }

  function updateCountdown() {
    if (nextRefreshAt === null) {
      countdown.textContent = 'Waiting…';
      return;
    }

    const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    countdown.textContent = seconds === 0 ? 'Refreshing…' : `In ${seconds}s`;
  }

  function scheduleRefresh(delayMs) {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    nextRefreshAt = Date.now() + delayMs;
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1_000);
    refreshTimer = setTimeout(() => refreshStatus(), delayMs);
  }

  function setLoading(isLoading) {
    refreshInFlight = isLoading;
    refreshButton.disabled = isLoading;
    refreshButton.classList.toggle('is-loading', isLoading);
    refreshButton.querySelector('span').textContent = isLoading ? 'Checking…' : 'Refresh now';
  }

  async function fetchSnapshot() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(STATUS_ENDPOINT, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`Status feed returned HTTP ${response.status}`);
      return normalizeSnapshot(await response.json());
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function refreshStatus() {
    if (refreshInFlight) return;

    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    nextRefreshAt = null;
    countdown.textContent = 'Refreshing…';
    setLoading(true);

    try {
      const snapshot = await fetchSnapshot();
      renderSnapshot(snapshot);
      scheduleRefresh(snapshot.refreshAfterMs);
    } catch {
      renderFailure();
      scheduleRefresh(RETRY_MS);
    } finally {
      setLoading(false);
    }
  }

  refreshButton.addEventListener('click', refreshStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && nextRefreshAt !== null && Date.now() >= nextRefreshAt) {
      refreshStatus();
    }
  });

  refreshStatus();
})();
