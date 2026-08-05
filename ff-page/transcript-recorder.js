/**
 * Keep a local copy of the conversation.
 *
 * The extension keeps conversations on Anthropic's side; nothing is written to
 * the browser profile, so there is no local history to go back to. This records
 * one by wrapping `fetch` in whichever context makes the call — the background
 * page and the panel both can — and reading a clone of each response.
 *
 * Deliberately format-tolerant. Anthropic's streaming shape is parsed for
 * readable text, and anything unrecognised is stored raw and truncated, so a
 * change upstream degrades the transcript rather than losing it.
 *
 * Everything lands in extension storage in plain text, inside the browser
 * profile. Turn it off with:
 *
 *     browser.storage.local.set({ffPortRecordTranscript: false})
 *
 * and clear what was already written from ff-page/transcript.html.
 */

(() => {
  'use strict';

  const ENABLED_PREF = 'ffPortRecordTranscript';
  const LOG_KEY = 'ffPortTranscript';

  /** Per-entry and whole-log ceilings, so a long session cannot fill the profile. */
  const MAX_TEXT_CHARS = 200_000;
  const MAX_ENTRIES = 4000;
  const FLUSH_DEBOUNCE_MS = 400;

  const RECORDED_HOSTS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.storage?.local || typeof globalThis.fetch !== 'function') return;
  if (globalThis.__ffTranscriptRecorder) return;
  globalThis.__ffTranscriptRecorder = true;

  let enabled = true;
  api.storage.local
    .get(ENABLED_PREF)
    .then((stored) => {
      if (stored && stored[ENABLED_PREF] === false) enabled = false;
    })
    .catch(() => {});

  api.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && ENABLED_PREF in changes) {
      enabled = changes[ENABLED_PREF].newValue !== false;
    }
  });

  // ------------------------------------------------------------------------
  // storage
  // ------------------------------------------------------------------------

  let pending = [];
  let flushTimer;
  let flushing = false;

  async function flush() {
    if (flushing || !pending.length) return;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      const stored = await api.storage.local.get(LOG_KEY);
      const log = stored?.[LOG_KEY] ?? [];
      log.push(...batch);
      // Oldest first out; the recent end of a conversation is the useful end.
      if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
      await api.storage.local.set({ [LOG_KEY]: log });
    } catch (error) {
      console.warn('[ff-port] could not write the transcript', error);
    } finally {
      flushing = false;
      if (pending.length) scheduleFlush();
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  }

  function record(entry) {
    pending.push({ at: Date.now(), context: contextName(), ...entry });
    scheduleFlush();
  }

  function contextName() {
    try {
      const path = location.pathname;
      if (path.includes('sidepanel')) return 'panel';
      if (path.includes('background')) return 'background';
      return path;
    } catch {
      return 'unknown';
    }
  }

  function truncate(text) {
    const value = String(text ?? '');
    return value.length > MAX_TEXT_CHARS
      ? `${value.slice(0, MAX_TEXT_CHARS)}\n…[truncated ${value.length - MAX_TEXT_CHARS} chars]`
      : value;
  }

  // ------------------------------------------------------------------------
  // parsing
  // ------------------------------------------------------------------------

  function isRecorded(url) {
    try {
      return RECORDED_HOSTS.some((host) => new URL(url).hostname.endsWith(host));
    } catch {
      return false;
    }
  }

  /** Pull the outgoing turns out of a request body, when it looks like one. */
  function parseRequest(body) {
    if (!body) return null;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { raw: truncate(body) };
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
    if (!messages) {
      const prompt = parsed.prompt ?? parsed.text ?? parsed.content;
      return prompt ? { turns: [{ role: 'user', text: truncate(prompt) }] } : { raw: truncate(body) };
    }

    return {
      model: parsed.model,
      turns: messages.map((message) => ({
        role: message.role ?? 'user',
        text: truncate(flattenContent(message.content)),
      })),
    };
  }

  function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? '');
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text ?? '';
        if (block?.type === 'tool_use') return `[tool_use ${block.name ?? ''}]`;
        if (block?.type === 'tool_result') return `[tool_result]`;
        return `[${block?.type ?? 'block'}]`;
      })
      .join('\n');
  }

  /**
   * Anthropic streams server-sent events; the assistant's words arrive as
   * `content_block_delta` fragments. Anything else is kept as-is.
   */
  function parseStream(payload) {
    if (!payload.includes('data:')) {
      try {
        const parsed = JSON.parse(payload);
        return { text: truncate(flattenContent(parsed.content ?? parsed)) };
      } catch {
        return { raw: truncate(payload) };
      }
    }

    let text = '';
    const events = [];
    for (const line of payload.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event?.delta?.text) text += event.delta.text;
      else if (event?.type) events.push(event.type);
    }

    if (!text) return { raw: truncate(payload), events: [...new Set(events)] };
    return { text: truncate(text), events: [...new Set(events)] };
  }

  // ------------------------------------------------------------------------
  // the fetch wrapper
  // ------------------------------------------------------------------------

  async function readBody(request) {
    try {
      return await request.clone().text();
    } catch {
      return null;
    }
  }

  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function (input, init) {
    const response = await nativeFetch(input, init);
    if (!enabled) return response;

    let url;
    try {
      url = typeof input === 'string' ? input : input?.url ?? String(input);
    } catch {
      return response;
    }
    if (!isRecorded(url)) return response;

    // Reading the clone must not hold up the caller, and must not throw into it.
    (async () => {
      try {
        const requestBody =
          init?.body != null
            ? String(init.body)
            : typeof input === 'object' && input?.clone
              ? await readBody(input)
              : null;

        const entry = {
          url,
          method: init?.method ?? (typeof input === 'object' ? input?.method : 'GET') ?? 'GET',
          status: response.status,
        };
        const request = parseRequest(requestBody);
        if (request) entry.request = request;

        const payload = await response.clone().text();
        if (payload) entry.response = parseStream(payload);

        record(entry);
      } catch (error) {
        console.warn('[ff-port] could not record a request', error);
      }
    })();

    return response;
  };

  // Do not lose the tail of a session when the context goes away.
  globalThis.addEventListener?.('pagehide', () => flush());
})();
