(function () {
  if (!globalThis.getDashboardBootstrap) {
    globalThis.getDashboardBootstrap = function getDashboardBootstrap() {
      return globalThis.__DASHBOARD_BOOTSTRAP__ || null;
    };
  }

  if (!globalThis.getDashboardSnapshotForPage) {
    globalThis.getDashboardSnapshotForPage = function getDashboardSnapshotForPage(page) {
      const bootstrap = globalThis.getDashboardBootstrap();
      if (!bootstrap) return null;
      const normalized = String(page || bootstrap.page || '').toLowerCase();
      if (normalized === 'home' || normalized === '/' || normalized === 'index') {
        return bootstrap.homeSummary || bootstrap.snapshot || bootstrap;
      }
      if (normalized === 'watch') {
        return bootstrap.watchSnapshot || bootstrap.snapshot || bootstrap;
      }
      if (normalized === 'control') {
        return bootstrap.controlSummary || bootstrap.snapshot || bootstrap;
      }
      return bootstrap.snapshot || bootstrap;
    };
  }

  if (globalThis.dashboardRequest) return;

  function createResponse({ status, headers, bodyText }) {
    const headerMap = new Map(Object.entries(headers || {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get(name) {
          return headerMap.get(String(name).toLowerCase()) || headerMap.get(name) || null;
        },
      },
      async json() {
        return JSON.parse(bodyText || 'null');
      },
      async text() {
        return bodyText || '';
      },
    };
  }

  function createDashboardRequest() {
    if (typeof globalThis.fetch === 'function') {
      return async function request(url, options = {}) {
        return globalThis.fetch(url, options);
      };
    }

    if (typeof XMLHttpRequest === 'undefined') {
      return null;
    }

    return async function request(url, options = {}) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url, true);
        if (options.headers) {
          for (const [key, value] of Object.entries(options.headers)) {
            xhr.setRequestHeader(key, value);
          }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return;
          resolve(createResponse({
            status: xhr.status || 0,
            headers: {},
            bodyText: xhr.responseText,
          }));
        };
        xhr.onerror = () => reject(new Error(`Request failed for ${url}`));
        xhr.send(options.body || null);
      });
    };
  }

  const request = createDashboardRequest();
  if (request) {
    globalThis.dashboardRequest = request;
  }
})();
