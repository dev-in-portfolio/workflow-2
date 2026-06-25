(() => {
  const installState = {
    deferredPrompt: null,
    banner: null,
    dismissed: false,
  };

  const STORAGE_KEY = 'trader-dashboard-install-dismissed';

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.navigator.standalone
      || false;
  }

  function shouldOfferInstall() {
    return !isStandalone() && !installState.dismissed;
  }

  function restoreDismissedState() {
    try {
      installState.dismissed = window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      installState.dismissed = false;
    }
  }

  function saveDismissedState(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }

  function createBanner() {
    if (installState.banner || !shouldOfferInstall()) return;
    const banner = document.createElement('aside');
    banner.className = 'install-banner';
    banner.id = 'installBanner';
    banner.innerHTML = `
      <div class="install-banner-copy">
        <strong>Install Trader Dashboard</strong>
        <small id="installBannerText">Open this in the browser menu to add it to your home screen.</small>
      </div>
      <div class="install-banner-actions">
        <button type="button" class="install-banner-button primary" id="installBannerButton">Install</button>
        <button type="button" class="install-banner-button ghost" id="installBannerDismiss">Dismiss</button>
      </div>
    `;
    document.body.classList.add('has-install-banner');
    document.body.appendChild(banner);
    installState.banner = banner;

    const installButton = banner.querySelector('#installBannerButton');
    const dismissButton = banner.querySelector('#installBannerDismiss');
    const text = banner.querySelector('#installBannerText');

    if (!installState.deferredPrompt) {
      installButton.textContent = 'How to install';
      text.textContent = 'Open the browser menu and choose Add to Home screen or Install app.';
    }

    installButton.addEventListener('click', async () => {
      if (installState.deferredPrompt) {
        installState.deferredPrompt.prompt();
        await installState.deferredPrompt.userChoice.catch(() => null);
        installState.deferredPrompt = null;
      } else {
        text.textContent = 'Use the browser menu, then choose Add to Home screen or Install app.';
      }
    });

    dismissButton.addEventListener('click', () => {
      installState.dismissed = true;
      saveDismissedState(true);
      banner.remove();
      installState.banner = null;
      document.body.classList.remove('has-install-banner');
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => null);
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installState.deferredPrompt = event;
    createBanner();
  });

  window.addEventListener('appinstalled', () => {
    installState.dismissed = true;
    saveDismissedState(true);
    installState.banner?.remove?.();
    installState.banner = null;
    installState.deferredPrompt = null;
    document.body.classList.remove('has-install-banner');
  });

  restoreDismissedState();
  registerServiceWorker();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createBanner, { once: true });
  } else {
    createBanner();
  }
})();
