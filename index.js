// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// v4 — generic extractor that adapts to multiple Gmail UI variants
// + diagnostic info on the response so selector-misses are debuggable.

const manifest = {
  type: 'gmail.unread',
  version: 4,
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
  extracts: ['count', 'messages', 'diagnostic'],
};

const FRESH_MS = 60 * 1000; // shorter while we tune selectors
const CACHE_KEY = 'lens.gmail.unread';
const GMAIL_TAB_PATTERN = 'https://mail.google.com/*';

function buildExtractScript() {
  return `(function () {
    const dbg = { variants_tried: [], row_count: 0, location: location.href, ready: document.readyState };

    // Strategy: Gmail's inbox is always inside a <div role="main">. Inside
    // it, conversation rows are either <tr role="row"> (classic table view)
    // OR <div role="row"> (newer container layouts). Cells are
    // <td role="gridcell"> or <div role="gridcell">.
    const main = document.querySelector('div[role="main"]');
    if (!main) {
      dbg.variants_tried.push('no-role-main');
      return { count: 0, messages: [], diagnostic: dbg };
    }
    let rows = main.querySelectorAll('tr[role="row"]');
    dbg.variants_tried.push('tr-role-row:' + rows.length);
    if (rows.length === 0) {
      rows = main.querySelectorAll('[role="row"]');
      dbg.variants_tried.push('any-role-row:' + rows.length);
    }
    if (rows.length === 0) {
      rows = main.querySelectorAll('li[role="listitem"]');
      dbg.variants_tried.push('listitem:' + rows.length);
    }
    rows = Array.from(rows);
    dbg.row_count = rows.length;
    if (rows.length === 0) {
      // Sample some DOM around main so we can debug what's actually there.
      dbg.main_first_child_tag = main.firstElementChild && main.firstElementChild.tagName;
      dbg.main_inner_preview = (main.innerText || '').slice(0, 200);
      return { count: 0, messages: [], diagnostic: dbg };
    }

    // Classify each row. Unread heuristic: ANY row with bold-weight text,
    // since Gmail bolds unread subjects across every variant we've seen.
    function isUnread(row) {
      // Cheapest first: class hint.
      if (/\\bzE\\b/.test(row.className || '')) return true;
      // Walk: if any descendant element has font-weight >=600, count as unread.
      const els = row.querySelectorAll('span, div, b, strong');
      for (let i = 0; i < els.length; i++) {
        const w = getComputedStyle(els[i]).fontWeight;
        if (parseInt(w, 10) >= 600) return true;
      }
      return false;
    }

    const unread = rows.filter(isUnread);
    dbg.unread_count = unread.length;
    // If our unread heuristic didn't find any, fall back to top rows. Some
    // Gmail variants pre-mark everything read; we still want to surface
    // SOMETHING for the user instead of empty.
    const target = unread.length > 0 ? unread : rows.slice(0, 10);

    function extractRow(row) {
      // Sender — strongest signals first:
      //   1. <span email="..."> or <span name="...">
      //   2. The first <span> whose text is shorter than 50 chars (Gmail
      //      sender cell is typically <60).
      //   3. First text content fragment that doesn't look like a subject.
      let sender = '';
      const emailSpan = row.querySelector('span[email], span[name]');
      if (emailSpan) {
        sender =
          emailSpan.getAttribute('email') ||
          emailSpan.getAttribute('name') ||
          (emailSpan.textContent && emailSpan.textContent.trim()) ||
          '';
      }
      if (!sender) {
        const cells = row.querySelectorAll('[role="gridcell"]');
        for (let i = 0; i < cells.length && i < 4; i++) {
          const t = (cells[i].textContent || '').trim();
          if (t && t.length > 0 && t.length < 80 && !/^\\s*$/.test(t)) {
            sender = t;
            break;
          }
        }
      }
      if (!sender) sender = '(unknown)';

      // Subject — Gmail puts the subject in the widest visible cell.
      // Heuristic: longest .textContent under a [role="gridcell"] that
      // isn't the sender we just picked.
      let subject = '';
      let snippet = '';
      const cells = row.querySelectorAll('[role="gridcell"], td, div');
      let longest = '';
      for (let i = 0; i < cells.length; i++) {
        const text = (cells[i].textContent || '').trim();
        if (text.length > longest.length && text !== sender) longest = text;
      }
      // Subject is typically before the first '—' separator; snippet is after.
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

      // Time
      const timeEl = row.querySelector(
        '[title][role], span[title], .xW span[title], .xW, td[role="gridcell"] [title]'
      );
      const time =
        (timeEl && timeEl.getAttribute && timeEl.getAttribute('title')) ||
        (timeEl && timeEl.textContent && timeEl.textContent.trim()) ||
        '';
      return { sender: sender, subject: subject, snippet: snippet, time: time };
    }

    const messages = target.slice(0, 10).map(extractRow);
    return { count: messages.length, messages: messages, diagnostic: dbg };
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

    // Cache fast path.
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
        // Empty cache → don't serve, fall through to live extract.
      }
    } catch {
      /* miss / unavailable */
    }

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
      diagnostic: result.diagnostic || null,
    };

    // Only cache when we actually got something useful.
    if (normalized.messages.length > 0) {
      try { await ctx.extension.cacheSet(CACHE_KEY, normalized); } catch { /* non-fatal */ }
    }

    return { ...normalized, _source: 'actInTab' };
  },
};
