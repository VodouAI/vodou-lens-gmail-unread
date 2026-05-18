// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// v5 — bulletproof extractor (no exceptions reach the bridge), surfaces
// extractor errors to the lens caller, and lowers the bar for what counts
// as a "row" so we don't return empty against a fully-rendered inbox.

const manifest = {
  type: 'gmail.unread',
  version: 5,
  motive:
    "Show the latest 10 unread emails from your Gmail inbox — sender, " +
    "subject, snippet — by reading the page you're already logged into " +
    "via Vodou Bridge.",
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
const GMAIL_TAB_PATTERN = 'https://mail.google.com/*';

// The page-context extractor. Every code path is try/wrapped so the bridge
// receives a structured result, never `{error: ...}` from runUserScript's
// outer catch (which would lose diagnostic info).
function buildExtractScript() {
  return `(function () {
    try {
      const dbg = {
        url: location.href,
        ready: document.readyState,
        title: document.title,
        variants: [],
        row_count: 0,
        unread_count: 0,
      };

      function findRows() {
        const main = document.querySelector('div[role="main"]');
        dbg.has_role_main = !!main;
        const scopes = [main || document.body];
        const tryQ = function (q, label) {
          for (let s = 0; s < scopes.length; s++) {
            try {
              const r = scopes[s].querySelectorAll(q);
              dbg.variants.push(label + ':' + r.length);
              if (r.length > 0) return Array.from(r);
            } catch (e) { dbg.variants.push(label + ':err'); }
          }
          return [];
        };
        let r = tryQ('tr[role="row"]', 'tr-role-row');
        if (r.length === 0) r = tryQ('[role="row"]', 'any-role-row');
        if (r.length === 0) r = tryQ('div[gh="tl"] [role="row"]', 'gh-tl-row');
        if (r.length === 0) r = tryQ('table.F.cf.zt tr', 'classic-tbl');
        if (r.length === 0) r = tryQ('li[role="listitem"]', 'listitem');
        return r;
      }

      const rows = findRows();
      dbg.row_count = rows.length;
      if (rows.length === 0) {
        const main = document.querySelector('div[role="main"]');
        if (main) {
          dbg.main_first_child_tag = main.firstElementChild ? main.firstElementChild.tagName : null;
          dbg.main_preview = (main.innerText || '').slice(0, 200);
        } else {
          dbg.body_preview = (document.body.innerText || '').slice(0, 200);
        }
        return { count: 0, messages: [], diagnostic: dbg };
      }

      function isUnread(row) {
        try {
          if (/\\bzE\\b/.test(row.className || '')) return true;
          // computed style on a few text-bearing descendants
          const els = row.querySelectorAll('span, div, b, strong');
          for (let i = 0; i < Math.min(els.length, 8); i++) {
            try {
              const w = getComputedStyle(els[i]).fontWeight;
              if (parseInt(w, 10) >= 600) return true;
              if (w === 'bold' || w === 'bolder') return true;
            } catch (_) { /* skip */ }
          }
        } catch (_) { /* skip */ }
        return false;
      }

      const unread = rows.filter(isUnread);
      dbg.unread_count = unread.length;
      const target = unread.length > 0 ? unread : rows.slice(0, 10);

      function extractRow(row) {
        let sender = '';
        try {
          const emailSpan = row.querySelector('span[email], span[name]');
          if (emailSpan) {
            sender =
              emailSpan.getAttribute('email') ||
              emailSpan.getAttribute('name') ||
              (emailSpan.textContent && emailSpan.textContent.trim()) ||
              '';
          }
        } catch (_) {}
        if (!sender) {
          try {
            const cells = row.querySelectorAll('[role="gridcell"]');
            for (let i = 0; i < Math.min(cells.length, 4); i++) {
              const t = (cells[i].textContent || '').trim();
              if (t && t.length > 0 && t.length < 80) {
                sender = t;
                break;
              }
            }
          } catch (_) {}
        }
        if (!sender) sender = '(unknown)';

        let longest = '';
        try {
          const cells = row.querySelectorAll('[role="gridcell"], td, div');
          for (let i = 0; i < Math.min(cells.length, 20); i++) {
            const text = (cells[i].textContent || '').trim();
            if (text.length > longest.length && text !== sender) longest = text;
          }
        } catch (_) {}
        let subject = '';
        let snippet = '';
        const dashIdx = longest.indexOf('—');
        if (dashIdx > 0) {
          subject = longest.slice(0, dashIdx).trim();
          snippet = longest.slice(dashIdx + 1).trim();
        } else {
          subject = longest.slice(0, 120).trim();
          snippet = longest.slice(120, 280).trim();
        }
        if (!subject) subject = '(no subject)';
        snippet = snippet.replace(/\\s+/g, ' ').slice(0, 140);

        let time = '';
        try {
          const timeEl = row.querySelector('[title]');
          time =
            (timeEl && timeEl.getAttribute && timeEl.getAttribute('title')) ||
            (timeEl && timeEl.textContent && timeEl.textContent.trim()) ||
            '';
        } catch (_) {}
        return { sender: sender, subject: subject, snippet: snippet, time: time };
      }

      const messages = [];
      for (let i = 0; i < Math.min(target.length, 10); i++) {
        try { messages.push(extractRow(target[i])); }
        catch (e) { dbg.extract_errors = (dbg.extract_errors || []); dbg.extract_errors.push(String(e && e.message || e)); }
      }
      return { count: messages.length, messages: messages, diagnostic: dbg };
    } catch (e) {
      return { count: 0, messages: [], error: String((e && e.message) || e), diagnostic: { trapped: true } };
    }
  })()`;
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

  async fetch(_payload, _sourceUrl, ctx) {
    if (!ctx.extension) {
      throw new Error(
        'gmail.unread requires Vodou Bridge. Install the Chrome extension from extension/vodou-bridge/ and click Connect.'
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
      throw new Error(
        `gmail.unread: extractor returned no result. raw=${JSON.stringify(result)}`
      );
    }

    // Surface the extractor's own error if present (helps tune selectors).
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

    return { ...normalized, _source: 'actInTab' };
  },
};
