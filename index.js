// gmail.unread — Vodou lens for the Gmail inbox (latest unread).
//
// REQUIRES VODOU BRIDGE. Reads the user's actual Gmail tab via the extension's
// `extract` verb so no OAuth, no API token, no MCP server is needed —
// the user is already logged into Chrome.
//
// This lens is read-only in v1. Actions (archive, mark-read, reply) ship in v2
// behind per-domain consent.
//
// Architecture note: Gmail uses heavy client-side JS, so we ask the Bridge to
// `extract` from the current tab (where the DOM has already rendered) rather
// than fetching mail.google.com server-HTML (which is a login-redirect shell).

const manifest = {
  type: 'gmail.unread',
  version: 1,
  motive:
    "Show the latest 10 unread emails from your Gmail inbox — sender, subject, " +
    "snippet — by reading the page you're already logged into via Vodou Bridge.",
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

// Default tab to read when the user invokes the lens without a URL.
// Anchor to mail.google.com/mail/u/0/#inbox so we hit the primary account.
const DEFAULT_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';

// Extract function injected into the Gmail tab. Runs in the page's context
// where the DOM is already rendered. Returns a serializable result.
//
// Gmail's inbox uses table rows with role="row" and class containing "zE"
// (unread) vs "zA" (read). Subject is in [data-thread-id] td:nth-child(5).
// Selectors are intentionally tolerant — Gmail's class names change but
// the role/aria-label structure is more stable.
function extractInboxFn() {
  const out = { count: 0, messages: [] };
  // Find the inbox table.
  const rows = Array.from(
    document.querySelectorAll('tr[role="row"], div[role="link"]')
  ).filter((r) => r.closest('[role="grid"], [role="main"]'));
  let unreadOnly = rows.filter((r) => {
    const cls = r.className || '';
    // Heuristic: unread rows include "zE" class on classic Gmail; bold subject on new UI.
    return /\bzE\b/.test(cls) || r.querySelector('.zF, b, strong');
  });
  // If we couldn't tell read-vs-unread (UI variant), fall back to first N rows.
  if (unreadOnly.length === 0) unreadOnly = rows;
  out.count = unreadOnly.length;
  for (const row of unreadOnly.slice(0, 10)) {
    // Sender: span[email] or span[name] in the leftmost name cell.
    const senderEl = row.querySelector(
      'span[email], span[name], .yX .yW span[email], .bA4 span'
    );
    const sender =
      senderEl?.getAttribute('email') ||
      senderEl?.getAttribute('name') ||
      senderEl?.textContent?.trim() ||
      '(unknown)';
    // Subject + snippet are in the same cell; subject is bold/strong, snippet is the rest.
    const subjectEl = row.querySelector(
      '.bog, .y6 span:first-child, [data-thread-id] [role="link"] > span'
    );
    const subject = subjectEl?.textContent?.trim() || '(no subject)';
    // Snippet text after "—" or in a sibling.
    const snippetEl = row.querySelector('.y2, .bog + span, .bA0');
    let snippet = snippetEl?.textContent?.trim() || '';
    if (snippet.startsWith('—')) snippet = snippet.slice(1).trim();
    snippet = snippet.replace(/\s+/g, ' ').slice(0, 140);
    // Time
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
    // Accept any mail.google.com URL or no URL (we'll default to inbox).
    if (!sourceUrl) return true;
    try {
      return new URL(sourceUrl).hostname.endsWith('mail.google.com');
    } catch {
      return false;
    }
  },

  async fetch(_payload, sourceUrl, ctx) {
    if (!ctx.extension) {
      throw new Error(
        'gmail.unread requires Vodou Bridge. Install the Chrome extension from extension/vodou-bridge/ and click Connect.'
      );
    }
    const url = sourceUrl && sourceUrl.includes('mail.google.com')
      ? sourceUrl
      : DEFAULT_INBOX_URL;
    // Bridge `extract` opens (or reuses) a tab matching the URL pattern
    // and runs the function in the page context. The user's session cookies
    // are present — Gmail renders as normal.
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
    return {
      count: typeof result.count === 'number' ? result.count : (result.messages || []).length,
      messages: Array.isArray(result.messages) ? result.messages.slice(0, 10) : [],
    };
  },
};
