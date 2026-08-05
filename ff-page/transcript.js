/**
 * Viewer and export for what ff-page/transcript-recorder.js collected.
 *
 * Read-only over extension storage, apart from the recording toggle and the
 * clear button. Export goes through a blob download rather than the downloads
 * API so it works the same whether or not that permission was granted.
 */

(() => {
  'use strict';

  const LOG_KEY = 'ffPortTranscript';
  const ENABLED_PREF = 'ffPortRecordTranscript';

  const api = globalThis.browser ?? globalThis.chrome;

  const elements = {
    summary: document.getElementById('summary'),
    entries: document.getElementById('entries'),
    search: document.getElementById('search'),
    recording: document.getElementById('recording'),
    exportMd: document.getElementById('export-md'),
    exportJson: document.getElementById('export-json'),
    clear: document.getElementById('clear'),
  };

  let log = [];

  function formatTime(at) {
    return new Date(at).toLocaleString();
  }

  function textOf(entry) {
    const parts = [];
    for (const turn of entry.request?.turns ?? []) parts.push(turn.text ?? '');
    if (entry.request?.raw) parts.push(entry.request.raw);
    if (entry.response?.text) parts.push(entry.response.text);
    if (entry.response?.raw) parts.push(entry.response.raw);
    return parts.join('\n');
  }

  function matches(entry, query) {
    if (!query) return true;
    const haystack = `${entry.url}\n${textOf(entry)}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  function turnElement(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'turn';

    const label = document.createElement('div');
    label.className = 'role';
    label.textContent = role;
    wrapper.append(label);

    const body = document.createElement('pre');
    body.textContent = text;
    wrapper.append(body);

    return wrapper;
  }

  function entryElement(entry) {
    const card = document.createElement('article');
    card.className = 'entry';

    const head = document.createElement('div');
    head.className = 'entry-head';

    const when = document.createElement('span');
    when.textContent = formatTime(entry.at);
    head.append(when);

    const where = document.createElement('span');
    where.textContent = `${entry.method} ${new URL(entry.url).pathname}`;
    head.append(where);

    const status = document.createElement('span');
    status.textContent = `HTTP ${entry.status}`;
    if (entry.status >= 400) status.className = 'status-bad';
    head.append(status);

    if (entry.context) {
      const context = document.createElement('span');
      context.textContent = entry.context;
      head.append(context);
    }
    if (entry.request?.model) {
      const model = document.createElement('span');
      model.textContent = entry.request.model;
      head.append(model);
    }

    card.append(head);

    for (const turn of entry.request?.turns ?? []) {
      card.append(turnElement(turn.role, turn.text));
    }
    if (entry.request?.raw) card.append(turnElement('request', entry.request.raw));
    if (entry.response?.text) card.append(turnElement('assistant', entry.response.text));
    if (entry.response?.raw) card.append(turnElement('response', entry.response.raw));

    return card;
  }

  function render() {
    const query = elements.search.value.trim();
    const visible = log.filter((entry) => matches(entry, query));

    elements.entries.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = log.length
        ? 'Ничего не найдено.'
        : 'Пока пусто. Поговорите с Claude — записи появятся здесь.';
      elements.entries.append(empty);
    } else {
      // Newest first: the end of a conversation is what you come back for.
      for (const entry of [...visible].reverse()) elements.entries.append(entryElement(entry));
    }

    const size = new Blob([JSON.stringify(log)]).size;
    elements.summary.textContent =
      `${log.length} записей, ${(size / 1024).toFixed(0)} КБ` +
      (query ? ` · показано ${visible.length}` : '');
  }

  function toMarkdown(entries) {
    const lines = ['# Локальная история Claude', ''];
    for (const entry of entries) {
      lines.push(`## ${formatTime(entry.at)} — ${entry.method} ${entry.url}`);
      lines.push('');
      if (entry.request?.model) lines.push(`Модель: \`${entry.request.model}\``, '');
      for (const turn of entry.request?.turns ?? []) {
        lines.push(`**${turn.role}**`, '', turn.text ?? '', '');
      }
      if (entry.request?.raw) lines.push('**request**', '', '```', entry.request.raw, '```', '');
      if (entry.response?.text) lines.push('**assistant**', '', entry.response.text, '');
      if (entry.response?.raw) lines.push('**response**', '', '```', entry.response.raw, '```', '');
      lines.push('---', '');
    }
    return lines.join('\n');
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  async function load() {
    const stored = await api.storage.local.get([LOG_KEY, ENABLED_PREF]);
    log = stored?.[LOG_KEY] ?? [];
    elements.recording.checked = stored?.[ENABLED_PREF] !== false;
    render();
  }

  elements.search.addEventListener('input', render);

  elements.recording.addEventListener('change', () => {
    api.storage.local.set({ [ENABLED_PREF]: elements.recording.checked });
  });

  elements.exportMd.addEventListener('click', () => {
    download(`claude-history-${stamp()}.md`, toMarkdown(log), 'text/markdown');
  });

  elements.exportJson.addEventListener('click', () => {
    download(`claude-history-${stamp()}.json`, JSON.stringify(log, null, 2), 'application/json');
  });

  elements.clear.addEventListener('click', async () => {
    if (!confirm('Удалить всю локальную историю? Это необратимо.')) return;
    await api.storage.local.remove(LOG_KEY);
    log = [];
    render();
  });

  // Stays live while a conversation is in progress.
  api.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (LOG_KEY in changes) {
      log = changes[LOG_KEY].newValue ?? [];
      render();
    }
    if (ENABLED_PREF in changes) {
      elements.recording.checked = changes[ENABLED_PREF].newValue !== false;
    }
  });

  load().catch((error) => {
    elements.summary.textContent = `Не удалось прочитать историю: ${error?.message ?? error}`;
  });
})();
