// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// REQUIRES VODOU BRIDGE. Reads the user's existing Gmail tab via the Bridge
// extension. No OAuth, no API token — the user is already logged in.
//
// v3 ARCHITECTURE: actInTab against an already-open Gmail tab + opportunistic
// observe()-cache. No hidden tab gets opened.
//
//   1. fetch() first reads ctx.extension.cacheGet('lens.gmail.unread').
//      If a snapshot exists AND is < FRESH_MS old → return it. NO TAB
//      operation at all. Pure local read.
//   2. On cache miss: ctx.extension.actInTab() runs the extractor in
//      the user's already-open Gmail tab. If no Gmail tab is open,
//      returns a clear actionable error.
//   3. observe() is invoked by the Bridge while the user is active on
//      Gmail; it refreshes the cache. (Future work — for now the cache
//      is seeded on every successful fetch.)
//
// v3 is read-only. Actions (archive, reply) ship in v4 behind per-domain
// consent.

const manifest = {
  type: 'gmail.unread',
  version: 3,
  motive:
    "Show the latest 10 unread emails from your Gmail inbox — sender, subject, " +
    "snippet — by reading the page you're already logged into via Vodou Bridge. " +
    "Reads from an already-open Gmail tab (no hidden tabs ever opened).",
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
  extracts: ['count', 'messages'],
};

const FRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'lens.gmail.unread';

// The DOM extractor — runs in the Gmail page context. Wrapped as an IIFE
// because the Bridge's runUserScript pattern is:
//     new Function('__args', `return (${scriptSrc})`)(args)
// so scriptSrc must evaluate to the *result*, not the function. The IIFE
// suffix `()` invokes it immediately.
//
// Gmail's inbox uses table rows with role="row". Class names rotate but
// the role/aria structure is more stable. We deliberately try multiple
// fallback selectors so a single Gmail UI variant doesn't break the lens.
function buildExtractScript() {
  // Function gets toString'd and wrapped at the call site below. Keep it
  // self-contained — no closures over this module's scope.
  const body = `(function() {
    const out = { count: 0, messages: [] };
    const rows = Array.from(
      document.querySelectorAll('tr[role="row"], div[role="link"]')
    ).filter(function(r) { return r.closest('[role="grid"], [role="main"]'); });
    let unreadOnly = rows.filter(function(r) {
      const cls = r.className || '';
      return /\\bzE\\b/.test(cls) || r.querySelector('.zF, b, strong');
    });
    if (unreadOnly.length === 0) unreadOnly = rows;
    out.count = unreadOnly.length;
    const top = unreadOnly.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      const senderEl = row.querySelector(
        'span[email], span[name], .yX .yW span[email], .bA4 span'
      );
      const sender =
        (senderEl && senderEl.getAttribute('email')) ||
        (senderEl && senderEl.getAttribute('name')) ||
        (senderEl && senderEl.textContent && senderEl.textContent.trim()) ||
        '(unknown)';
      const subjectEl = row.querySelector(
        '.bog, .y6 span:first-child, [data-thread-id] [role="link"] > span'
      );
      const subject =
        (subjectEl && subjectEl.textContent && subjectEl.textContent.trim()) ||
        '(no subject)';
      const snippetEl = row.querySelector('.y2, .bog + span, .bA0');
      let snippet =
        (snippetEl && snippetEl.textContent && snippetEl.textContent.trim()) || '';
      if (snippet.charAt(0) === '\\u2014') snippet = snippet.slice(1).trim();
      snippet = snippet.replace(/\\s+/g, ' ').slice(0, 140);
      const timeEl = row.querySelector(
        '.xW span[title], .xW, td[role="gridcell"] [title]'
      );
      const time =
        (timeEl && timeEl.getAttribute('title')) ||
        (timeEl && timeEl.textContent && timeEl.textContent.trim()) ||
        '';
      out.messages.push({ sender: sender, subject: subject, snippet: snippet, time: time });
    }
    return out;
  })()`;
  return body;
}

// Bridge URL pattern format for `actInTab` — Chrome match-pattern.
const GMAIL_TAB_PATTERN = 'https://mail.google.com/*';

export const card = {
  manifest,

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
        'gmail.unread requires Vodou Bridge. Install the Chrome extension from extension/vodou-bridge/ and click Connect in the popup.'
      );
    }

    // 1. Cache fast path.
    try {
      const cached = await ctx.extension.cacheGet(CACHE_KEY);
      if (
        cached &&
        typeof cached.updated_at === 'number' &&
        Date.now() - cached.updated_at < FRESH_MS
      ) {
        const v = cached.value || {};
        return {
          count: typeof v.count === 'number' ? v.count : (v.messages || []).length,
          messages: Array.isArray(v.messages) ? v.messages.slice(0, 10) : [],
          _source: 'cache',
          _cache_age_ms: Date.now() - cached.updated_at,
        };
      }
    } catch {
      /* cache miss / unavailable — fall through */
    }

    // 2. Run the extractor in an open Gmail tab. If none is open, error
    //    clearly so the user knows exactly what to do.
    let result;
    try {
      const res = await ctx.extension.actInTab(GMAIL_TAB_PATTERN, buildExtractScript());
      result = res && res.result;
    } catch (err) {
      const msg = err && (err.message || String(err));
      if (msg && /NO_MATCHING_TAB/i.test(msg)) {
        throw new Error(
          'Open a Gmail tab and try again — gmail.unread reads your existing logged-in tab, so https://mail.google.com/ must be open in Chrome.'
        );
      }
      throw new Error(`Vodou Bridge actInTab failed: ${msg}`);
    }

    if (!result || typeof result !== 'object') {
      return { count: 0, messages: [] };
    }
    const normalized = {
      count: typeof result.count === 'number' ? result.count : (result.messages || []).length,
      messages: Array.isArray(result.messages) ? result.messages.slice(0, 10) : [],
    };

    // 3. Seed the cache so subsequent reads in the next 5 min are instant.
    try {
      await ctx.extension.cacheSet(CACHE_KEY, normalized);
    } catch {
      /* non-fatal */
    }

    return { ...normalized, _source: 'actInTab' };
  },
};
