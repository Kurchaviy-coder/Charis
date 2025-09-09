// cloudflare_redirect.js
(function() {
  'use strict';

  // --- Настройки: поменяй URL воркера ---
  const CLOUDFLARE_ENABLED_STORAGE_KEY = 'enableCloudflareRedirect_v1';
  const CLOUDFLARE_WORKER_URL = 'https://gemini-proxy.xlebovichxleb140.workers.dev/'; // <-- ВАШ воркер
  const CLOUDFLARE_CHECKBOX_ID = 'enableCloudflareRedirect';
  const GEMINI_API_URL_PREFIX = 'https://generativelanguage.googleapis.com/';
  const FALLBACK_ON_ERROR = false; // если true — при ошибке прокси попробует обратиться к оригинальному URL (не всегда работает для больших потоков)

  let useCloudflareRedirect = localStorage.getItem(CLOUDFLARE_ENABLED_STORAGE_KEY) === 'true';

  // добавить чекбокс в настройки (если есть элемент с id 'enableGoogleApi' в DOM)
  function addCloudflareCheckbox() {
    if (document.getElementById(CLOUDFLARE_CHECKBOX_ID)) return;
    const googleApiSwitch = document.getElementById('enableGoogleApi');
    if (!googleApiSwitch) return;
    const parent = googleApiSwitch.closest('.switch')?.parentElement || googleApiSwitch.parentElement;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:0.6rem;';
    wrapper.innerHTML = `
      <label for="${CLOUDFLARE_CHECKBOX_ID}" style="font-weight:500;">
        <strong>Cloudflare</strong>: проксировать запросы Gemini
      </label>
      <label class="switch">
        <input type="checkbox" id="${CLOUDFLARE_CHECKBOX_ID}">
        <span class="slider round"></span>
      </label>
    `;
    parent.appendChild(wrapper);
    const cb = document.getElementById(CLOUDFLARE_CHECKBOX_ID);
    cb.checked = useCloudflareRedirect;
    cb.addEventListener('change', e => {
      useCloudflareRedirect = e.target.checked;
      localStorage.setItem(CLOUDFLARE_ENABLED_STORAGE_KEY, useCloudflareRedirect);
      console.log('[cloudflare_redirect] useCloudflareRedirect =', useCloudflareRedirect);
    });
  }

  // Утилита: нормализовать заголовки (Headers || plain object)
  function buildHeaders(src) {
    const h = new Headers();
    if (!src) return h;
    if (src instanceof Headers) {
      for (const [k, v] of src.entries()) h.set(k, v);
    } else if (Array.isArray(src)) {
      for (const [k, v] of src) h.set(k, v);
    } else if (typeof src === 'object') {
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v != null) h.set(k, String(v));
      }
    }
    return h;
  }

  // --- Патчим window.fetch ---
  function patchFetch() {
    if (window.fetch.isPatched) return;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async function(input, init = {}) {
      try {
        const isRequestObj = input instanceof Request;
        const origUrl = isRequestObj ? input.url : String(input || '');
        // не вмешиваемся, если редирект выключен или URL не Gemini
        if (!useCloudflareRedirect || !origUrl.startsWith(GEMINI_API_URL_PREFIX)) {
          return originalFetch(input, init);
        }

        console.log('[cloudflare_redirect] intercepting:', origUrl);

        // Собираем опции исходного запроса
        const srcHeaders = buildHeaders(init.headers || (isRequestObj ? input.headers : null));
        srcHeaders.set('X-Original-URL', origUrl);

        // Если был Origin — оставим его (воркер обработает)
        // Не пробуем руками менять Content-Length и Host

        const method = (init.method || (isRequestObj ? input.method : 'POST')).toUpperCase();

        // Тело: если init.body задан — используем, иначе если это Request — используем input.body (stream)
        let body = init.body;
        if (body == null && isRequestObj) {
          // NOTE: Request.body это ReadableStream и может быть одноразовым. Не читаем тут.
          body = input.body;
        }

        const fetchOptions = {
          method,
          headers: srcHeaders,
          body,
          // Передаём другие поля, если есть (credentials могут быть важны)
          credentials: init.credentials || (isRequestObj ? input.credentials : undefined),
          redirect: init.redirect || (isRequestObj ? input.redirect : undefined),
          referrer: init.referrer || (isRequestObj ? input.referrer : undefined),
          referrerPolicy: init.referrerPolicy || (isRequestObj ? input.referrerPolicy : undefined),
          // signal: init.signal || (isRequestObj ? input.signal : undefined), // сигнал нельзя клонировать безопасно
        };

        // Попытка сделать запрос к воркеру.
        try {
          return await originalFetch(CLOUDFLARE_WORKER_URL, fetchOptions);
        } catch (err) {
          console.error('[cloudflare_redirect] fetch to worker failed:', err);
          if (FALLBACK_ON_ERROR) {
            console.warn('[cloudflare_redirect] falling back to original URL (may fail for geo-blocked requests)');
            return originalFetch(input, init);
          }
          throw err;
        }
      } catch (outerErr) {
        console.error('[cloudflare_redirect] unexpected patch error:', outerErr);
        // на случай внутренней ошибки возвращаем оригинальный fetch
        return originalFetch(input, init);
      }
    };

    window.fetch.isPatched = true;
    console.log('[cloudflare_redirect] fetch patched.');
  }

  // Наблюдаем DOM, чтобы добавить чекбокс и патчить, когда страница готова
  const observer = new MutationObserver(() => {
    addCloudflareCheckbox();
    patchFetch();
  });

  function init() {
    try {
      addCloudflareCheckbox();
      patchFetch();
      const target = document.getElementById('settingsSection') || document.body;
      observer.observe(target, { childList: true, subtree: true });
    } catch (e) {
      console.error('[cloudflare_redirect] init failed', e);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('load', init);
    setTimeout(init, 1000); // запасной вариант
  }
})();