/**
 * Keep tab grouping consistent, falling back to bookkeeping when the browser
 * does not do it for us.
 *
 * Firefox 139+ implements `tabGroups` and Firefox 138+ implements
 * `tabs.group()`, so this is not about a missing API. It is about the bundle's
 * contract with it:
 *
 *   const id = await chrome.tabs.group({tabIds: [tab], createProperties: {…}})
 *   …
 *   if ((await chrome.tabs.get(tab)).groupId !== id) throw new Error(
 *     `Tab ${tab} is not in the same group as ${main}`)
 *
 * Every agent action re-checks that equality, so anything that makes the two
 * disagree — grouping disabled in the profile, `createProperties` ignored, a
 * `groupId` the tab object does not carry back — stops the agent on its first
 * step with exactly that error.
 *
 * So: try the browser first, then verify. When the browser agrees, nothing
 * changes and native grouping is used as-is. When it does not, the grouping is
 * tracked here instead and reported through the same reads, so the bundle's
 * invariant holds either way. The visible tab strip loses the grouping in that
 * case; the agent keeps working, which is the trade worth making.
 */

const { NATIVE, overrideNamespace, warn } = globalThis.__ffPort;

const NONE = NATIVE.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

/** Ids for groups we track ourselves, far from anything the browser hands out. */
let nextTrackedId = 900_001;

/** tabId -> groupId */
const groupByTab = new Map();
/** groupId -> {id, windowId, title, color, collapsed} */
const trackedGroups = new Map();

let reported = false;

function reportOnce(reason, detail) {
  if (reported) return;
  reported = true;
  console.warn(
    `[ff-port] native tab grouping did not hold (${reason}); tracking groups in ` +
      'the extension instead. Groups will not show in the tab strip.\n  ' +
      detail,
  );
}

function isTracked(groupId) {
  return trackedGroups.has(groupId);
}

/** Report the grouping we track, when we track one for this tab. */
function annotate(tab) {
  if (!tab) return tab;
  const tracked = groupByTab.get(tab.id);
  if (tracked !== undefined) return { ...tab, groupId: tracked };
  // Firefox omits groupId on tabs that are in no group; the bundle compares it
  // against TAB_GROUP_ID_NONE and treats undefined as "in some group".
  if (tab.groupId === undefined || tab.groupId === null) {
    return { ...tab, groupId: NONE };
  }
  return tab;
}

function trackGroup(tabIds, options) {
  let groupId = options.groupId;
  if (groupId === undefined || !trackedGroups.has(groupId)) {
    groupId = nextTrackedId++;
    trackedGroups.set(groupId, {
      id: groupId,
      windowId: options.createProperties?.windowId ?? NONE,
      title: '',
      color: 'grey',
      collapsed: false,
    });
  }
  for (const tabId of tabIds) groupByTab.set(tabId, groupId);
  return groupId;
}

const tabsOverrides = {
  async group(options = {}) {
    const tabIds = [].concat(options.tabIds ?? []);

    // Adding to a group we already track: the browser knows nothing about it.
    if (options.groupId !== undefined && isTracked(options.groupId)) {
      return trackGroup(tabIds, options);
    }

    if (typeof NATIVE.tabs.group === 'function') {
      try {
        const groupId = await NATIVE.tabs.group(options);
        const [first] = tabIds;
        if (first === undefined) return groupId;

        const tab = await NATIVE.tabs.get(first);
        if (tab.groupId === groupId) {
          // The browser holds the grouping; drop any bookkeeping for these tabs.
          for (const tabId of tabIds) groupByTab.delete(tabId);
          return groupId;
        }
        reportOnce(
          'groupId mismatch',
          `tabs.group() returned ${JSON.stringify(groupId)} but tabs.get(${first}).groupId ` +
            `is ${JSON.stringify(tab.groupId)}`,
        );
      } catch (error) {
        reportOnce('tabs.group() failed', String(error?.message ?? error));
      }
    } else {
      reportOnce('tabs.group() is unavailable', 'this Firefox has no tab grouping API');
    }

    return trackGroup(tabIds, options);
  },

  async ungroup(tabIds) {
    const ids = [].concat(tabIds ?? []);
    const hadTracked = ids.some((tabId) => groupByTab.has(tabId));
    for (const tabId of ids) groupByTab.delete(tabId);
    if (hadTracked) return undefined;
    try {
      return await NATIVE.tabs.ungroup(tabIds);
    } catch (error) {
      warn('tabs.ungroup failed', error);
      return undefined;
    }
  },

  async get(tabId) {
    return annotate(await NATIVE.tabs.get(tabId));
  },

  async query(queryInfo = {}) {
    const { groupId, ...rest } = queryInfo;
    // Filtering happens here rather than in the browser: a tracked groupId
    // means nothing to it, and a native one still matches after annotate().
    const tabs = (await NATIVE.tabs.query(rest)).map(annotate);
    if (groupId === undefined) return tabs;
    return tabs.filter((tab) => tab.groupId === groupId);
  },
};

const tabGroupsOverrides = {
  // Chrome exposes these as runtime constants. Firefox 139+ does too, so the
  // native values win where they exist.
  TAB_GROUP_ID_NONE: NONE,
  Color: NATIVE.tabGroups?.Color ?? {
    GREY: 'grey',
    BLUE: 'blue',
    RED: 'red',
    YELLOW: 'yellow',
    GREEN: 'green',
    PINK: 'pink',
    PURPLE: 'purple',
    CYAN: 'cyan',
    ORANGE: 'orange',
  },

  async get(groupId) {
    if (isTracked(groupId)) return { ...trackedGroups.get(groupId) };
    return NATIVE.tabGroups.get(groupId);
  },

  async query(queryInfo = {}) {
    let native = [];
    try {
      native = await NATIVE.tabGroups.query(queryInfo);
    } catch (error) {
      warn('tabGroups.query failed', error);
    }
    const tracked = [...trackedGroups.values()].filter((group) => {
      if (queryInfo.windowId !== undefined && group.windowId !== queryInfo.windowId) return false;
      if (queryInfo.collapsed !== undefined && group.collapsed !== queryInfo.collapsed) return false;
      if (queryInfo.title !== undefined && group.title !== queryInfo.title) return false;
      if (queryInfo.color !== undefined && group.color !== queryInfo.color) return false;
      return true;
    });
    return [...native, ...tracked.map((group) => ({ ...group }))];
  },

  async update(groupId, properties = {}) {
    if (isTracked(groupId)) {
      const group = { ...trackedGroups.get(groupId), ...properties };
      trackedGroups.set(groupId, group);
      return { ...group };
    }
    try {
      return await NATIVE.tabGroups.update(groupId, properties);
    } catch (error) {
      // Cosmetic only — title and colour do not affect whether the agent runs.
      warn('tabGroups.update failed', error);
      return { id: groupId, ...properties };
    }
  },
};

NATIVE.tabs.onRemoved.addListener((tabId) => groupByTab.delete(tabId));

overrideNamespace('tabs', tabsOverrides);
overrideNamespace('tabGroups', tabGroupsOverrides);

if (!NATIVE.tabGroups) {
  warn('tabGroups is unavailable; grouping will be tracked entirely in the extension');
}
