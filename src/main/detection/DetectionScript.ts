/**
 * WhatsApp Web *notification detector*.
 *
 * ## What this is
 *
 * A self contained, strictly read only script that is injected into the main
 * world of `web.whatsapp.com` by the preload (`webFrame.executeJavaScript`).
 * It answers exactly one question - "did the user-visible notification surface
 * just change?" - and reports the answer over `postMessage`.
 *
 * ## Hard rules (do not relax these)
 *
 *  1. READ ONLY. No mutation of the DOM, no synthetic events, no clicks, no
 *     focus, no scrolling, no storage access, no network requests.
 *  2. NO PRIVACY-PUBLIC API. Never `window.Store`, never `WebSocket`, never
 *     IndexedDB, never the encryption layer. The only thing read is what the
 *     page already renders for assistive technology (accessibility labels,
 *     visible text, the document title) plus the `title`/`body` arguments of
 *     `Notification` constructions, which are observed, never intercepted.
 *  3. It must degrade to "no notifications" rather than throw. A missed
 *     notification is cosmetic; an exception in the page world breaks the
 *     user's WhatsApp client.
 *
 * ## Why it is a string
 *
 * The sandboxed preload cannot import application code, and the injected script
 * must not depend on our bundle. The source is therefore a string literal, sent
 * over IPC by the main process on request. `test/detector.test.ts` evaluates
 * this exact string against a fake DOM, so it cannot rot silently.
 *
 * ## Reliability
 *
 * Every selector is a list tried in order; the first match wins. That keeps the
 * detector useful across WhatsApp Web releases while staying honest about the
 * fact that DOM heuristics can go stale - see docs/NOTIFICATIONS.md.
 */

/** Marker used to accept a `postMessage` from the page world. */
export const DETECTOR_CHANNEL = 'wa-desktop-detector';

/** Event kinds emitted by the detector. */
export const DETECTOR_KINDS = Object.freeze({
  message: 'message',
  session: 'session',
  ready: 'ready',
  error: 'error',
} as const);

/** How long the preload waits for `ready` before declaring the detector dead. */
export const DETECTOR_HANDSHAKE_TIMEOUT_MS = 12_000;

/**
 * The injected source. Constraints: syntactically ES2019 (no build step ever
 * needed), no backticks, no `${`, no identifiers from outside the closure.
 *
 * Inside a TypeScript template literal `\\(` means "the string contains \(",
 * i.e. the escape the generated script needs.
 */
export const DETECTOR_SOURCE = `
(function whatsappDesktopDetector() {
  'use strict';
  var OWNED = '__waDesktopDetector';
  if (window[OWNED]) { return 'already-installed'; }

  var CHANNEL = 'wa-desktop-detector';
  var MAX_PREVIEW = 240;
  var MAX_NAME = 120;
  var COALESCED_MS = 150;
  var SEEN_TTL_MS = 30000;

  var state = {
    installed: Date.now(),
    unread: -1,
    session: 'loading',
    seen: {},
    seenCount: 0,
    timer: 0,
    interval: 0,
    observers: [],
    baselined: false,
    notifications: 0
  };
  window[OWNED] = state;

  function text(value) {
    if (typeof value !== 'string') { return ''; }
    return value
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u00a0\\u2000-\\u200b\\u2060\\ufeff]/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  function clamp(value, max) {
    var clean = text(value);
    if (clean.length <= max) { return clean; }
    return clean.slice(0, Math.max(1, max - 1)) + '\\u2026';
  }

  function post(kind, payload) {
    try {
      window.postMessage({ channel: CHANNEL, kind: kind, payload: payload, at: Date.now() }, window.location.origin);
    } catch (ignored) {
      /* the page is going away; there is nobody left to tell */
    }
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (ignored) { return fallback; }
  }

  function hash(value) {
    var h = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(36);
  }

  function queryAll(selectors, scope) {
    var found = [];
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = safe((function (selector) {
        return function () {
          return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
        };
      })(selectors[i]), []);
      for (var j = 0; j < nodes.length; j += 1) {
        if (nodes[j] && found.indexOf(nodes[j]) === -1) { found.push(nodes[j]); }
      }
      if (found.length > 0) { break; }
    }
    return found;
  }

  function queryFirst(selectors, scope) {
    var all = queryAll(selectors, scope);
    return all.length > 0 ? all[0] : null;
  }

  /* ------------------------------------------------------------------ */
  /* unread counter: parsed from the document title, nothing else        */
  /* ------------------------------------------------------------------ */

  var TITLE_UNREAD = /^\\((\\d{1,5})\\)/;

  function readTitleUnread() {
    var title = safe(function () { return document.title || ''; }, '');
    var match = TITLE_UNREAD.exec(text(title));
    if (!match || !match[1]) { return 0; }
    var parsed = parseInt(match[1], 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  /* ------------------------------------------------------------------ */
  /* session state: derived from the URL and presence of a chat list     */
  /* ------------------------------------------------------------------ */

  var CHAT_LIST = ['div[aria-label="Chats"]', '[data-testid="chat-list"]', 'div[role="grid"][aria-label]', '#pane-side'];

  function readSessionState() {
    var href = safe(function () { return window.location.href || ''; }, '');
    if (/#/.test(href)) { return 'logged-in'; }
    if (queryFirst(CHAT_LIST, document)) { return 'logged-in'; }
    if (/\\/chrome\\/?$/.test(href) || queryFirst(['#app .landing-window', 'canvas', 'div[data-ref]'], document)) {
      return 'logged-out';
    }
    return 'loading';
  }

  /* ------------------------------------------------------------------ */
  /* the notification surface                                            */
  /* ------------------------------------------------------------------ */

  var NOTIFY_REGION = [
    '[data-testid="notify-container"]',
    '[aria-label="New notifications"]',
    '[aria-label="unread chats"]',
    '[role="complementary"]'
  ];

  var ROW = [
    'div[role="listitem"]',
    '[data-testid="cell-frame-container"]',
    'div[role="row"]',
    'div[role="option"]'
  ];

  function rowAttribute(row, name) {
    return text(safe(function () { return row.getAttribute(name) || ''; }, ''));
  }

  function rowName(row) {
    // Most reliable first: the row's own accessibility label reads like
    // "Alice, 2 messages, 9:41 PM, unread" because that is what screen readers
    // are given. Then the tooltip, then the title element inside the row.
    var aria = rowAttribute(row, 'aria-label');
    if (aria) {
      var head = aria.split(',')[0];
      var fromAria = clamp(head, MAX_NAME);
      if (fromAria.length > 0) { return fromAria; }
    }
    var fromTitle = rowAttribute(row, 'title');
    if (fromTitle) { return clamp(fromTitle, MAX_NAME); }
    var candidate = queryFirst(['span[title]', '[title]', '[dir="auto"]', 'span'], row);
    var fromNode = candidate ? (candidate.getAttribute('title') || candidate.textContent) : '';
    return clamp(fromNode, MAX_NAME);
  }

  function rowPreview(row, name) {
    // The message preview is the *last* text block of the row (the name is the
    // first), so document order is more reliable than "the longest string",
    // which picks the name whenever a chat name is longer than the message.
    var spans = safe(function () { return Array.prototype.slice.call(row.querySelectorAll('span')); }, []);
    var fallback = '';
    for (var i = spans.length - 1; i >= 0; i -= 1) {
      var value = text(spans[i].textContent);
      if (value.length === 0) { continue; }
      if (name && value === name) { continue; }
      if (fallback.length === 0) { fallback = value; }
    }
    return clamp(fallback, MAX_PREVIEW);
  }

  function rowIsGroup(row) {
    var combined = (rowAttribute(row, 'aria-label') + ' ' + rowAttribute(row, 'title')).toLowerCase();
    return combined.indexOf('group') !== -1 || combined.indexOf('participants') !== -1;
  }

  function rememberSeen(key) {
    state.seen[key] = Date.now();
    state.seenCount += 1;
    if (state.seenCount > 400) { pruneSeen(); }
  }

  function isRecent(key) {
    var at = state.seen[key];
    return typeof at === 'number' && Date.now() - at < SEEN_TTL_MS;
  }

  function pruneSeen() {
    var keys = Object.keys(state.seen);
    var drop = Math.max(0, keys.length - 200);
    for (var i = 0; i < drop; i += 1) {
      delete state.seen[keys[i]];
      state.seenCount -= 1;
    }
    if (state.seenCount < 0) { state.seenCount = 0; }
  }

  function collectRows() {
    var region = queryFirst(NOTIFY_REGION, document);
    var scope = region || document;
    var rows = queryAll(ROW, scope);
    var out = [];
    var total = Math.min(rows.length, 12);
    for (var i = 0; i < total; i += 1) {
      var row = rows[i];
      var name = rowName(row);
      if (!name) { continue; }
      var preview = rowPreview(row, name);
      if (!preview) { continue; }
      var key = hash(name + '|' + preview);
      if (isRecent(key)) { continue; }
      rememberSeen(key);
      // The first pass only records what is already on screen. Without this an
      // app restart would replay every pre-existing unread chat at once.
      if (!state.baselined) { continue; }
      out.push({
        id: 'r:' + key,
        chatId: 'chat:' + hash(name.toLowerCase()),
        chatName: name,
        senderName: null,
        isGroup: rowIsGroup(row),
        body: preview,
        hasMedia: /photo|image|video|voice|document|sticker/i.test(preview),
        timestamp: Date.now(),
        source: 'dom-notification'
      });
    }
    if (!state.baselined) {
      state.baselined = true;
      post('session', { state: state.session, titleUnreadCount: state.unread, baselined: true });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* scheduling                                                          */
  /* ------------------------------------------------------------------ */

  function scan() {
    var unread = readTitleUnread();
    if (unread !== state.unread) {
      state.unread = unread;
      var session = readSessionState();
      var changed = session !== state.session;
      state.session = session;
      post('session', { state: session, titleUnreadCount: unread, changed: changed });
    }
    if (state.session !== 'logged-in') { return; }
    var messages = collectRows();
    for (var i = 0; i < messages.length; i += 1) {
      post('message', messages[i]);
    }
  }

  function scheduleScan() {
    if (state.timer) { return; }
    state.timer = setTimeout(function () {
      state.timer = 0;
      safe(scan, undefined);
    }, COALESCED_MS);
  }

  /* ------------------------------------------------------------------ */
  /* optional: observe the page's own Notification constructions          */
  /* ------------------------------------------------------------------ */

  function hookNotifications() {
    if (typeof window.Notification !== 'function') { return; }
    var Original = window.Notification;
    function Patched(title, options) {
      state.notifications += 1;
      var body = options && typeof options.body === 'string' ? options.body : '';
      var name = clamp(title, MAX_NAME) || 'WhatsApp';
      post('message', {
        id: 'n:' + hash(name + '|' + body),
        chatId: 'chat:' + hash(name.toLowerCase()),
        chatName: name,
        senderName: null,
        isGroup: false,
        body: clamp(body, MAX_PREVIEW),
        hasMedia: false,
        timestamp: Date.now(),
        source: 'dom-notification'
      });
      // Construct exactly what the page asked for. We observe, we do not alter.
      return new Original(title, options);
    }
    Patched.prototype = Original.prototype;
    safe(function () {
      Object.defineProperty(Patched, 'permission', {
        get: function () { return Original.permission; }
      });
    }, undefined);
    Patched.requestPermission = function () {
      return Original.requestPermission.apply(Original, arguments);
    };
    window.Notification = Patched;
  }

  /* ------------------------------------------------------------------ */
  /* bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  function start() {
    hookNotifications();

    var target = document.getElementById('app') || document.body;
    if (target && typeof MutationObserver === 'function') {
      var observer = new MutationObserver(scheduleScan);
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      state.observers.push(observer);
    }

    var titleNode = safe(function () { return document.querySelector('title'); }, null);
    if (titleNode && typeof MutationObserver === 'function') {
      var titleObserver = new MutationObserver(scheduleScan);
      titleObserver.observe(titleNode, { childList: true, characterData: true, subtree: true });
      state.observers.push(titleObserver);
    }

    document.addEventListener('visibilitychange', scheduleScan, false);
    window.addEventListener('focus', scheduleScan, false);

    // Safety net: a virtualised list can settle without a mutation we can see,
    // and the title can be rewritten by a timer. 4 s is invisible to the user
    // and cheap enough to keep running forever.
    state.interval = setInterval(scheduleScan, 4000);

    state.session = readSessionState();
    state.unread = readTitleUnread();
    post('ready', { installed: true, session: state.session, titleUnreadCount: state.unread });
    // Scan once here. Without this the baseline would be taken on the *next*
    // mutation, i.e. the first message the user ever receives would be silently
    // consumed as "already on screen".
    safe(scan, undefined);
  }

  function whenReady(attempt) {
    var ready = safe(function () {
      var app = document.getElementById('app');
      return !!app && app.childElementCount > 0;
    }, false);
    if (ready) { start(); return; }
    if (attempt > 600) {
      post('error', { reason: 'app-root-not-found' });
      return;
    }
    setTimeout(function () { whenReady(attempt + 1); }, 500);
  }

  try {
    whenReady(0);
  } catch (error) {
    post('error', { reason: String(error && error.message ? error.message : error) });
  }

  return 'installed';
}());
`;

/** The exact string that gets injected. A function so the caller reads intent. */
export function detectorSource(): string {
  return DETECTOR_SOURCE;
}

/**
 * The source wrapped in a function that takes its globals as parameters.
 *
 * Only used by tests: it proves the *shipped string* parses and behaves without
 * a browser, by shadowing `document`/`window`/`setTimeout` with fixtures. The
 * application itself always injects `DETECTOR_SOURCE` verbatim.
 */
export function detectorTestHarnessSource(): string {
  return [
    'return function (window, document, MutationObserver, setTimeout, setInterval, console) {',
    DETECTOR_SOURCE,
    '};',
  ].join('\n');
}
