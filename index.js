// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// REQUIRES VODOU BRIDGE. Reads the user's actual Gmail tab via the extension.
// No OAuth, no API token, no MCP server — the user is already logged in.
//
// v2 ARCHITECTURE: opportunistic cache-first.
//
//   1. observe(): when the user is on mail.google.com, the Bridge extension
//      runs the same DOM extractor every 30s while that tab is active and
//      snapshots the inbox into chrome.storage.local under key
//      `lens.gmail.unread`.
//   2. fetch(): first reads ctx.extension.cacheGet('lens.gmail.unread').
//      If a snapshot exists AND is < FRESH_MS old → return it. NO TAB OPENED.
//      Otherwise falls back to extract (hidden tab) and writes the result
//      to the cache so the next read is fast.
//
// Net effect: if the user has been on Gmail in the last 5 minutes, the
// lens responds instantly with zero tab churn. If they haven't, it pays
// the one-time hidden-tab cost.
//
// v1 is read-only. Actions (archive, reply) ship in v3 behind per-domain
// consent.

const manifest = {
  type: 'gmail.unread',
  version: 2,
  motive:
    "Show the latest 10 unread emails from your Gmail inbox — sender, subject, " +
    "snippet — by reading the page you're already logged into via Vodou Bridge. " +
    "Uses an opportunistic cache so no tab is opened when you've recently visited Gmail.",
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

// Snapshot freshness window. If the cache is older than this, refresh
// via extract. 5 min is a reasonable balance — short enough that you
// don't get truly stale unread counts, long enough that walking away
// from your computer for a meeting doesn't trigger a tab open.
const FRESH_MS = 5 * 60 * 1000;

// Cache key — namespaced under "lens." so it doesn't collide with other
// extension storage usage.
const CACHE_KEY = 'lens.gmail.unread';

const DEFAULT_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';

// Extractor function — runs in the Gmail page context. Same as v1.
// Returns a serializable result. See README for selector reasoning.
function extractInboxFn() {
  const out = { count: 0, messages: [] };
  const rows = Array.from(
    document.querySelectorAll('tr[role="row"], div[role="link"]')
  ).filter((r) => r.closest('[role="grid"], [role="main"]'));
  let unreadOnly = rows.filter((r) => {
    const cls = r.className || '';
    return /\bzE\b/.test(cls) || r.querySelector('.zF, b, strong');
  });
  if (unreadOnly.length === 0) unreadOnly = rows;
  out.count = unreadOnly.length;
  for (const row of unreadOnly.slice(0, 10)) {
    const senderEl = row.querySelector(
      'span[email], span[name], .yX .yW span[email], .bA4 span'
    );
    const sender =
      senderEl?.getAttribute('email') ||
      senderEl?.getAttribute('name') ||
      senderEl?.textContent?.trim() ||
      '(unknown)';
    const subjectEl = row.querySelector(
      '.bog, .y6 span:first-child, [data-thread-id] [role="link"] > span'
    );
    const subject = subjectEl?.textContent?.trim() || '(no subject)';
    const snippetEl = row.querySelector('.y2, .bog + span, .bA0');
    let snippet = snippetEl?.textContent?.trim() || '';
    if (snippet.startsWith('—')) snippet = snippet.slice(1).trim();
    snippet = snippet.replace(/\s+/g, ' ').slice(0, 140);
    const timeEl = row.querySelector(
      '.xW span[title], .xW, td[role="gridcell"] [title]'
    );
    const time =
      timeEl?.getAttribute('title') || timeEl?.textContent?.trim() || '';
    out.messages.push({ sender, subject, snippet, time });
  }
  return out;
}

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

  /**
   * observe() — Vodou's ambient hook. When the user is on a matching tab,
   * the extension calls this so we can update our snapshot cache. The
   * implementation: extract the inbox, write to cache. The extension batches
   * calls (≥30s apart per tab) so this stays cheap.
   */
  async observe(sourceUrl, ctx) {
    if (!ctx.extension) return;
    try {
      const result = await ctx.extension.extract(sourceUrl, extractInboxFn);
      if (result && typeof result === 'object') {
        await ctx.extension.cacheSet(CACHE_KEY, result);
      }
    } catch {
      // Observe failures are silent — the user didn't ask for anything.
    }
  },

  async fetch(_payload, sourceUrl, ctx) {
    if (!ctx.extension) {
      throw new Error(
        'gmail.unread requires Vodou Bridge. Install the Chrome extension from extension/vodou-bridge/ and click Connect.'
      );
    }
    // 1. Try the cache first. The whole point of v2.
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
          _cache_age_ms: Date.now() - cached.updated_at,
          _source: 'cache',
        };
      }
    } catch {
      // Cache layer down — fall through to extract.
    }

    // 2. Fallback: hidden-tab extract. Pays the tab-open cost once; result
    // is written to cache so the next read is fast.
    const url = sourceUrl && sourceUrl.includes('mail.google.com')
      ? sourceUrl
      : DEFAULT_INBOX_URL;
    let result;
    try {
      result = await ctx.extension.extract(url, extractInboxFn);
    } catch (err) {
      throw new Error(
        'Vodou Bridge extract failed — is mail.google.com open and logged in? ' +
          (err?.message || err)
      );
    }
    if (!result || typeof result !== 'object') {
      return { count: 0, messages: [] };
    }
    const normalized = {
      count: typeof result.count === 'number' ? result.count : (result.messages || []).length,
      messages: Array.isArray(result.messages) ? result.messages.slice(0, 10) : [],
    };
    // Seed the cache so subsequent calls hit the fast path.
    try {
      await ctx.extension.cacheSet(CACHE_KEY, normalized);
    } catch {
      // Cache write failure is non-fatal.
    }
    return {
      ...normalized,
      _source: 'extract',
    };
  },
};
