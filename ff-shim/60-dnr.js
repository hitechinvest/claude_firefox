/**
 * declarativeNetRequest enum objects.
 *
 * Firefox implements the API itself (113+, including `modifyHeaders`) but does
 * not expose Chrome's enum constants as runtime objects.  The extension builds
 * its rules out of them:
 *
 *   action: {type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
 *            requestHeaders: [{header: 'User-Agent',
 *                              operation: chrome.declarativeNetRequest
 *                                           .HeaderOperation.SET, …}]}
 *
 * Without these, reading `.MODIFY_HEADERS` off `undefined` throws and the rules
 * that attach the extension's identifying headers to api.anthropic.com requests
 * are never installed.
 *
 * The values are the wire strings the rules are serialised to, so Firefox
 * accepts them unchanged.  Members Firefox already provides are left alone.
 */

const { extendNamespace } = globalThis.__ffPort;

const RuleActionType = {
  BLOCK: 'block',
  REDIRECT: 'redirect',
  ALLOW: 'allow',
  UPGRADE_SCHEME: 'upgradeScheme',
  MODIFY_HEADERS: 'modifyHeaders',
  ALLOW_ALL_REQUESTS: 'allowAllRequests',
};

const HeaderOperation = {
  APPEND: 'append',
  SET: 'set',
  REMOVE: 'remove',
};

const ResourceType = {
  MAIN_FRAME: 'main_frame',
  SUB_FRAME: 'sub_frame',
  STYLESHEET: 'stylesheet',
  SCRIPT: 'script',
  IMAGE: 'image',
  FONT: 'font',
  OBJECT: 'object',
  XMLHTTPREQUEST: 'xmlhttprequest',
  PING: 'ping',
  CSP_REPORT: 'csp_report',
  MEDIA: 'media',
  WEBSOCKET: 'websocket',
  WEBTRANSPORT: 'webtransport',
  WEBBUNDLE: 'webbundle',
  OTHER: 'other',
};

const DomainType = { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' };

const RequestMethod = {
  CONNECT: 'connect',
  DELETE: 'delete',
  GET: 'get',
  HEAD: 'head',
  OPTIONS: 'options',
  PATCH: 'patch',
  POST: 'post',
  PUT: 'put',
  OTHER: 'other',
};

extendNamespace('declarativeNetRequest', {
  RuleActionType,
  HeaderOperation,
  ResourceType,
  DomainType,
  RequestMethod,
});
