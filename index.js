// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// v6 — uses the extension's CSP-safe `extract_builtin` verb. Gmail
// ships strict Content Security Policy headers that block `new Function()`
// (the mechanism `act_in_tab` relied on for arbitrary scripts). The
// extension's BUILTIN_EXTRACTORS registry has a hardcoded Gmail extractor
// dispatched via chrome.scripting.executeScript({func: realFn}), which
// uses Chrome's privileged injection path and bypasses CSP eval rules.
//
// Trade-off: the extractor lives in the extension, not the lens.
// Community contributors who want a new CSP-strict site PR the extractor
// function into extension/vodou-bridge/background.js.

const manifest = {
  type: 'gmail.unread',
  version: 8,
  motive:
    "Show the latest 10 unread emails from your Gmail inbox — sender, " +
    "subject, snippet — by reading the page you're already logged into " +
    "via Vodou Bridge. Uses the extension's CSP-safe built-in extractor.",
  url_patterns: [
    'mail.google.com/mail/u/*/#inbox',
    'mail.google.com/mail/u/*/#search/is:unread',
    'mail.google.com/**',
  ],
  ttl_seconds: 60,
  requires: {
    network_domains: ['mail.google.com'],
    runs_js: false,
    paths: ['bridge'],
    cookie_scope: 'session',
    needs_session: true,
  },
  icon: '📩',
  category: 'communication',
  author: '@vodou',
  license: 'MIT',
  extracts: ['count', 'messages', 'diagnostic', 'error'],
};

const FRESH_MS = 60 * 1000;
const CACHE_KEY = 'lens.gmail.unread';
const EXTRACTOR_ID = 'gmail.unread';

export const card = {
  manifest,

  // Row-click action: navigate the user's existing Gmail tab to the thread
  // URL in place. Uses Bridge openUrl with match_url so the user lands in
  // their already-logged-in session, not a fresh popup.
  actions: {
    open_thread: {
      label: 'Open email',
      requiresConsent: false,
      async run(_model, ctx) {
        const url =
          (ctx && ctx.payload && ctx.payload.url) ||
          (ctx && ctx.sourceUrl) ||
          '';
        if (!url) return { ok: false, message: 'no URL provided' };
        if (!ctx.extension || typeof ctx.extension.openUrl !== 'function') {
          return { ok: false, message: 'Vodou Bridge not connected' };
        }
        try {
          const r = await ctx.extension.openUrl(url, {
            match_url: 'https://mail.google.com/*',
          });
          return { ok: true, message: r.reused ? 'navigated existing Gmail tab' : 'opened new tab' };
        } catch (e) {
          return { ok: false, message: String(e && e.message || e) };
        }
      },
    },
  },

  validate(_payload, sourceUrl) {
    if (!sourceUrl) return true;
    try {
      return new URL(sourceUrl).hostname.endsWith('mail.google.com');
    } catch {
      return false;
    }
  },

  async fetch(_payload, _sourceUrl, ctx) {
    if (!ctx.extension) {
      throw new Error(
        'gmail.unread requires Vodou Bridge. Install the Chrome extension from extension/vodou-bridge/ and click Connect.'
      );
    }
    if (typeof ctx.extension.extractBuiltin !== 'function') {
      throw new Error(
        'gmail.unread requires Vodou Bridge v0.5.91.1 or later (extract_builtin verb). Reload the extension at chrome://extensions.'
      );
    }

    // Cache fast path — only serve non-empty cached results.
    try {
      const cached = await ctx.extension.cacheGet(CACHE_KEY);
      if (
        cached &&
        typeof cached.updated_at === 'number' &&
        Date.now() - cached.updated_at < FRESH_MS
      ) {
        const v = cached.value || {};
        if (Array.isArray(v.messages) && v.messages.length > 0) {
          return {
            count: typeof v.count === 'number' ? v.count : v.messages.length,
            messages: v.messages.slice(0, 10),
            _source: 'cache',
            _cache_age_ms: Date.now() - cached.updated_at,
          };
        }
      }
    } catch { /* miss */ }

    // CSP-safe extract via the extension's built-in.
    let result;
    try {
      result = await ctx.extension.extractBuiltin(EXTRACTOR_ID);
    } catch (err) {
      const msg = err && (err.message || String(err));
      if (msg && /NO_MATCHING_TAB/i.test(msg)) {
        throw new Error(
          'Open a Gmail tab and try again — gmail.unread reads your existing logged-in tab, so https://mail.google.com/ must be open in Chrome.'
        );
      }
      if (msg && /UNKNOWN_EXTRACTOR/i.test(msg)) {
        throw new Error(
          "Vodou Bridge doesn't know the 'gmail.unread' extractor. Reload the extension at chrome://extensions (need v0.5.91.1+)."
        );
      }
      throw new Error(`Vodou Bridge extract_builtin failed: ${msg}`);
    }

    if (!result || typeof result !== 'object') {
      throw new Error(
        `gmail.unread: extractor returned no result. raw=${JSON.stringify(result)}`
      );
    }

    if (result.error) {
      throw new Error(
        `gmail.unread extractor error: ${result.error} (diagnostic: ${JSON.stringify(result.diagnostic || {})})`
      );
    }

    const normalized = {
      count: typeof result.count === 'number' ? result.count : (result.messages || []).length,
      messages: Array.isArray(result.messages) ? result.messages.slice(0, 10) : [],
      diagnostic: result.diagnostic || null,
    };

    if (normalized.messages.length > 0) {
      try { await ctx.extension.cacheSet(CACHE_KEY, normalized); } catch { /* non-fatal */ }
    }

    return { ...normalized, _source: 'extract_builtin' };
  },
};
