/**
 * Compatibility layer for the extension's own pages (sidepanel.html,
 * options.html).
 *
 * They run the same bundle as the background but in a separate context, so
 * they need the same `chrome.*` gaps filled.  Loaded as a module, ahead of the
 * page's own module bundle: module scripts execute in document order, so
 * everything here is in place before the first line of the bundle runs.
 *
 * The split matters.  Namespaces that are pure value lookups or read-only
 * queries are installed locally; the ones that own global state — debugger
 * sessions, the offscreen document, the sidebar — are forwarded to the
 * background instead, so there is exactly one owner per browser session.
 */

import '../ff-shim/00-bootstrap.js';
import '../ff-shim/10-runtime.js';
import '../ff-shim/60-dnr.js';
import './proxy-client.js';
