// ==UserScript==
// @name        Wealthsimple export transactions as OFX
// @namespace   Violentmonkey Scripts
// @match       https://my.wealthsimple.com/*
// @grant       GM.xmlHttpRequest
// @version     1.21
// @license     MIT
// @author      Peter Kieser
// @description Adds export buttons to the Activity feed and account activity pages that export transactions as OFX, with real ledger balances, memo-only trades and monthly market gain/loss entries for investment accounts, registered/non-registered labels, and a reconciliation table in the console.
// ==/UserScript==

const LOG = "[ofx-export]";
const SCRIPT_VERSION =
    (typeof GM_info !== "undefined" && GM_info?.script?.version) || "unknown";
console.log(`${LOG} Loaded v${SCRIPT_VERSION}`);

/**
 * @typedef {Object} PageInfo
 * @property {"account-details" | "activity" | null} pageType
 * @property {HTMLElement?} anchor - Buttons are inserted after this element.
 * @property {(() => boolean)?} readyPredicate
 */

/**
 * Figures out which page we're on and where to attach buttons. Must not do any
 * network requests, because MutationObserver calls it constantly.
 * @returns {PageInfo}
 */
function getPageInfo() {
    const emptyInfo = { pageType: null, anchor: null, readyPredicate: null };
    const info = { ...emptyInfo };

    const pathParts = window.location.pathname.split("/");
    if (pathParts.length === 4 && pathParts[2] === "account-details") {
        // Class names are minified, so anchor on an icon path instead.
        const accountSelectorQuery = `div:has( > button > div > div > div > svg > path[d="M6.363 3.363a.9.9 0 0 1 1.274 0l4 4a.9.9 0 0 1 0 1.274l-4 4a.9.9 0 0 1-1.274-1.274L9.727 8 6.363 4.637a.9.9 0 0 1 0-1.274Z"])`;
        info.pageType = "account-details";
        const anchor = document.querySelectorAll(accountSelectorQuery);
        if (anchor.length !== 1) return emptyInfo;
        info.anchor = anchor[0];
        info.readyPredicate = () => info.anchor.parentNode.children.length >= 1;
    } else if (pathParts.length === 3 && pathParts[2] === "activity") {
        info.pageType = "activity";
        const anchor = Array.from(document.querySelectorAll("h1")).find(
            (el) => el.textContent === "Activity",
        );
        if (anchor === undefined) return emptyInfo;
        info.anchor = anchor.parentNode;
        info.readyPredicate = () => info.anchor.parentNode.children.length >= 1;
    } else {
        return emptyInfo;
    }
    return info;
}

/**
 * Account IDs selected in the Activity page's account filter, read from the
 * URL at click time. Handles both "account_ids=a,b" and repeated
 * "account_ids=a&account_ids=b". Returns null when no filter is applied.
 * @returns {string[]?}
 */
function getActivityFilterAccountIds() {
    const params = new URLSearchParams(window.location.search);
    const ids = params
        .getAll("account_ids")
        .flatMap((v) => v.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    console.log(
        `${LOG} Activity filter: query string "${window.location.search}" -> ` +
            (ids.length ? ids.join(", ") : "no account filter, exporting all accounts"),
    );
    return ids.length ? ids : null;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const wsOfxExportSettings = {
    swapMemoPayee: false,
    // In investment accounts, export buys/sells with amount 0 and the
    // dollar value in the memo, so cash stays "in" the account.
    tradesAsMemoOnly: true,
    // In investment accounts, add one "Market gain/loss" entry per completed
    // month so the transactions add up to the account's value.
    monthlyMarketGains: true,
    // Add an "Opening balance" entry when an account's history starts after it
    // already held money. Off when the app already has the older transactions.
    openingBalance: false,
    // Debugging: print every buy/sell and dividend exactly as Wealthsimple returned it.
    logRawTrades: false,
    // Debugging: log the GraphQL requests Wealthsimple's own pages make.
    captureGraphql: false,
};
window.wsOfxExportSettings = wsOfxExportSettings;

const WS_OFX_SETTINGS_KEY = "wsOfxExportSettings";

const loadedSettings = loadWsOfxExportSettings();
if (loadedSettings) {
    Object.assign(wsOfxExportSettings, loadedSettings);
    console.log(`${LOG} Loaded saved settings`, { ...wsOfxExportSettings });
}

function loadWsOfxExportSettings() {
    const raw = localStorage.getItem(WS_OFX_SETTINGS_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error(`${LOG} Failed to parse saved settings:`, e);
        return null;
    }
}

function saveWsOfxExportSettings() {
    localStorage.setItem(WS_OFX_SETTINGS_KEY, JSON.stringify(wsOfxExportSettings));
    console.log(`${LOG} Settings saved`, { ...wsOfxExportSettings });
}

/* ------------------------------------------------------------------ */
/* Button injection                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* GraphQL capture (debugging)                                         */
/* ------------------------------------------------------------------ */

// Requests whose name or response mention these are logged in full; the
// rest are listed by operation name only.
const CAPTURE_INTEREST = /order|exchange|fx|currency|price|security|fill/i;

function logCapturedGraphql(source, bodyText, responseText) {
    if (!wsOfxExportSettings.captureGraphql) return;
    let ops = [];
    try {
        const parsed = JSON.parse(bodyText);
        ops = (Array.isArray(parsed) ? parsed : [parsed]).map((b) => ({
            operationName: b.operationName,
            variables: b.variables,
            query: b.query,
        }));
    } catch (e) {
        ops = [{ operationName: "(unparsed body)", query: String(bodyText).slice(0, 2000) }];
    }
    const names = ops.map((o) => o.operationName).join(", ");
    const interesting = CAPTURE_INTEREST.test(names) || CAPTURE_INTEREST.test(String(responseText).slice(0, 20000));
    if (!interesting) {
        console.log(`${LOG}[capture] ${names} (not logged in full)`);
        return;
    }
    console.log(
        `${LOG}[capture] ${names} via ${source}\n` +
            "----- BEGIN CAPTURED REQUEST -----\n" +
            JSON.stringify(ops, null, 2) +
            "\n----- RESPONSE -----\n" +
            String(responseText).slice(0, 8000) +
            "\n----- END CAPTURED REQUEST -----",
    );
}

/**
 * Wraps the page's fetch and XMLHttpRequest so the site's own GraphQL calls
 * can be logged. Only request bodies and responses are logged, never headers
 * (which hold the login token). Does nothing unless the setting is on.
 */
function installGraphqlCapture() {
    const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    try {
        if (target.__ofxGraphqlCapture) return;
        target.__ofxGraphqlCapture = true;

        const origFetch = target.fetch;
        target.fetch = function (input, init) {
            const promise = origFetch.apply(this, arguments);
            try {
                const url = typeof input === "string" ? input : input?.url;
                if (wsOfxExportSettings.captureGraphql && url && url.includes("graphql")) {
                    const body = typeof init?.body === "string" ? init.body : null;
                    promise
                        .then((resp) => resp.clone().text())
                        .then((text) => logCapturedGraphql("fetch", body, text))
                        .catch(() => {});
                }
            } catch (e) {
                // Never interfere with the site
            }
            return promise;
        };

        const proto = target.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function (method, url) {
            this.__ofxUrl = url;
            return origOpen.apply(this, arguments);
        };
        proto.send = function (body) {
            try {
                if (wsOfxExportSettings.captureGraphql && String(this.__ofxUrl || "").includes("graphql")) {
                    this.addEventListener("load", () => {
                        try {
                            logCapturedGraphql("xhr", typeof body === "string" ? body : null, this.responseText);
                        } catch (e) {}
                    });
                }
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
        console.log(`${LOG} GraphQL capture ready (turn it on in the gear menu)`);
    } catch (e) {
        console.warn(`${LOG} GraphQL capture unavailable in this browser/userscript mode:`, String(e));
    }
}
installGraphqlCapture();

const exportCsvId = "export-transactions-csv";

function keepButtonShown() {
    if (document.querySelector(`div#${exportCsvId}`)) return;

    const pageInfo = getPageInfo();
    if (!pageInfo.pageType) return;
    if (!pageInfo.readyPredicate || !pageInfo.readyPredicate()) return;

    console.log(`${LOG} Adding buttons`);
    addButtons(pageInfo);
}

(function () {
    const observer = new MutationObserver((mutations) => {
        if (mutations.length) keepButtonShown();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
        // Give the site's framework time to update classes before copying them.
        await new Promise((res) => setTimeout(res, 100));
        themeButtons();
    });

    window.addEventListener("load", () => keepButtonShown());
})();

/** Matches light/dark theme by copying styling from the site's search button. */
function themeButtons() {
    const profileButton = document.querySelector('button[aria-label="Search"]');
    if (!profileButton) return;
    for (const button of document.querySelectorAll("button.export-csv-button")) {
        button.className = ["export-csv-button", profileButton.className].join(" ");
    }
    const profileStyle = window.getComputedStyle(profileButton);
    const settings = document.querySelector("div.export-csv-setting");
    if (settings) {
        settings.style.background = profileStyle.background;
        settings.style.border = profileStyle.border;
    }
}

/**
 * Attaches the button row. Synchronous so the row can't be attached twice.
 * @param {PageInfo} pageInfo
 */
function addButtons(pageInfo) {
    const buttonRow = document.createElement("div");
    buttonRow.id = exportCsvId;
    buttonRow.style.display = "flex";
    buttonRow.style.alignItems = "baseline";
    buttonRow.style.gap = "1em";
    buttonRow.style.marginLeft = "auto";

    const buttonRowText = document.createElement("span");
    buttonRowText.innerText = "Export Transactions as OFX:";
    buttonRow.appendChild(buttonRowText);

    const now = new Date();
    const buttons = [
        { text: "Last 2 Weeks", fromDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14) },
        { text: "This Month", fromDate: new Date(now.getFullYear(), now.getMonth(), 1) },
        { text: "All", fromDate: null },
    ];

    for (const button of buttons) {
        const exportButton = document.createElement("button");
        exportButton.innerText = button.text;
        exportButton.className = "export-csv-button";
        exportButton.onclick = async () => {
            try {
                console.log(`${LOG} Export started (range: ${button.text})`);
                const accountsInfo = await accountFinancials();
                const { balances } = await fetchBalances();

                // Read the page and filter at click time, not when the buttons
                // were created: the site is a single-page app, so the URL can
                // change while the button row stays on screen.
                let transactions = [];
                let accountIds;
                const pathParts = window.location.pathname.split("/");
                if (pathParts[2] === "account-details") {
                    accountIds = [pathParts[3]];
                    console.log(`${LOG} Account page: exporting ${accountIds[0]}`);
                    transactions = await activityList(accountIds, button.fromDate);
                } else {
                    accountIds = getActivityFilterAccountIds() ?? accountsInfo.map((a) => a.id);
                    transactions = await activityFeedItems(accountIds, button.fromDate);
                }

                // Enforce the filter locally too, in case the API ignores it.
                const wanted = new Set(accountIds);
                const fetchedCount = transactions.length;
                transactions = transactions.filter((t) => wanted.has(t.accountId));
                console.log(
                    `${LOG} Fetched ${fetchedCount} transactions, kept ${transactions.length} matching the account filter`,
                );

                const blobs = await transactionsToOfxBlobs(
                    transactions,
                    accountsInfo,
                    balances,
                    button.text,
                    button.fromDate,
                    accountIds,
                );
                saveBlobsToFiles(blobs);
                console.log(`${LOG} Export finished: ${Object.keys(blobs).length} file(s)`);
            } catch (e) {
                console.error(`${LOG} Export failed:`, e);
            }
        };
        buttonRow.appendChild(exportButton);
    }

    // Settings button and menu
    const settingsWrapper = document.createElement("div");
    settingsWrapper.style.position = "relative";
    settingsWrapper.style.display = "inline-block";

    const settingsButton = document.createElement("button");
    settingsButton.className = "export-csv-button";
    settingsButton.style.padding = "0.4em 0.6em";
    settingsButton.title = "Settings";
    settingsButton.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24M19.78 19.78l-4.24-4.24m-5.08-5.08l-4.24-4.24"></path>
      </svg>
    `;

    const settingsMenu = document.createElement("div");
    settingsMenu.className = "export-csv-setting";
    Object.assign(settingsMenu.style, {
        position: "absolute",
        top: "100%",
        right: "0",
        marginTop: "0.4em",
        padding: "0.8em 1em",
        zIndex: "10000",
        minWidth: "260px",
        display: "none",
        borderRadius: "12px",
        fontSize: "14px",
    });

    const menuTitle = document.createElement("div");
    menuTitle.style.fontWeight = "bold";
    menuTitle.style.marginBottom = "0.8em";
    menuTitle.textContent = "Export Settings";
    settingsMenu.appendChild(menuTitle);

    function createSettingToggle(optionKey, label) {
        const wrapper = document.createElement("label");
        Object.assign(wrapper.style, {
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            marginBottom: "0.6em",
            userSelect: "none",
        });
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = wsOfxExportSettings[optionKey];
        checkbox.style.marginRight = "0.6em";
        checkbox.style.cursor = "pointer";
        checkbox.addEventListener("change", () => {
            wsOfxExportSettings[optionKey] = checkbox.checked;
            saveWsOfxExportSettings();
        });
        wrapper.appendChild(checkbox);
        wrapper.appendChild(document.createTextNode(label));
        return wrapper;
    }

    settingsMenu.appendChild(createSettingToggle("swapMemoPayee", "Swap memo/payee"));
    settingsMenu.appendChild(
        createSettingToggle("tradesAsMemoOnly", "Trades as memo only (investment accounts)"),
    );
    settingsMenu.appendChild(
        createSettingToggle("monthlyMarketGains", "Monthly market gain/loss (investment accounts)"),
    );
    settingsMenu.appendChild(
        createSettingToggle("openingBalance", "Opening balance entry (\"All\" exports)"),
    );
    settingsMenu.appendChild(createSettingToggle("logRawTrades", "Log raw trade records (console)"));
    settingsMenu.appendChild(createSettingToggle("captureGraphql", "Capture site GraphQL requests (console)"));

    const diagLabel = "Run diagnostics (console)";
    const diagButton = document.createElement("button");
    diagButton.className = "export-csv-button";
    diagButton.textContent = diagLabel;
    diagButton.style.marginTop = "0.4em";
    diagButton.onclick = async (e) => {
        e.stopPropagation();
        diagButton.disabled = true;
        diagButton.textContent = "Running…";
        try {
            await runDiagnostics();
        } finally {
            diagButton.disabled = false;
            diagButton.textContent = diagLabel;
        }
    };
    settingsMenu.appendChild(diagButton);

    document.addEventListener("mousedown", (e) => {
        if (!settingsWrapper.contains(e.target)) settingsMenu.style.display = "none";
    });

    settingsButton.onclick = (e) => {
        e.stopPropagation();
        settingsMenu.style.display = settingsMenu.style.display === "none" ? "block" : "none";
    };

    settingsWrapper.appendChild(settingsButton);
    settingsWrapper.appendChild(settingsMenu);
    buttonRow.appendChild(settingsWrapper);

    pageInfo.anchor.after(buttonRow);
    pageInfo.anchor.parentNode.style.gap = "1em";
    pageInfo.anchor.style.marginLeft = "0";

    themeButtons();
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} OauthCookie
 * @property {string} access_token
 * @property {string} identity_canonical_id
 */

/** @returns {OauthCookie?} */
function getOauthCookie() {
    const cookies = decodeURIComponent(document.cookie).split(";");
    for (const cookieKV of cookies) {
        if (cookieKV.indexOf("_oauth2_access_v2") !== -1) {
            return JSON.parse(cookieKV.slice(cookieKV.indexOf("=") + 1));
        }
    }
    return null;
}

/**
 * Sends a GraphQL request. Never logs the access token.
 * With strict (default), throws on HTTP errors or when no data comes back.
 * Partial errors alongside data are logged as warnings.
 */
async function gql(operationName, query, variables = {}, { strict = true } = {}) {
    const token = getOauthCookie()?.access_token;
    if (!token) throw `${LOG} Not logged in (no OAuth cookie found)`;

    const resp = await GM.xmlHttpRequest({
        url: "https://my.wealthsimple.com/graphql",
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
        },
        data: JSON.stringify({ operationName, query, variables }),
    });

    let body = null;
    try {
        body = JSON.parse(resp.responseText);
    } catch (e) {
        // Not JSON; handled below
    }
    const result = {
        status: resp.status,
        data: body?.data ?? null,
        errors: body?.errors ?? null,
        rawText: body ? null : String(resp.responseText ?? "").slice(0, 500),
    };

    if (strict) {
        if (resp.status !== 200 || !result.data) {
            const detail = result.errors
                ? JSON.stringify(result.errors.map((e) => e.message))
                : result.rawText;
            throw `${LOG} ${operationName} failed (HTTP ${resp.status}): ${detail}`;
        }
        if (result.errors) {
            console.warn(
                `${LOG} ${operationName} returned partial errors:`,
                result.errors.map((e) => e.message),
            );
        }
    }
    return result;
}

/**
 * Subset of the ActivityFeedItem GraphQL type.
 * @typedef {Object} Transaction
 */

const activityFeedItemFragment = `
      fragment Activity on ActivityFeedItem {
        accountId
        externalCanonicalId
        amount
        amountSign
        occurredAt
        type
        subType
        eTransferEmail
        eTransferName
        assetSymbol
        assetQuantity
        aftOriginatorName
        aftTransactionCategory
        aftTransactionType
        canonicalId
        currency
        identityId
        institutionName
        p2pHandle
        p2pMessage
        spendMerchant
        securityId
        billPayCompanyName
        billPayPayeeNickname
        redactedExternalAccountNumber
        opposingAccountId
        status
        strikePrice
        contractType
        expiryDate
        chequeNumber
        provisionalCreditAmount
        primaryBlocker
        interestRate
        frequency
        counterAssetSymbol
        rewardProgram
        counterPartyCurrency
        counterPartyCurrencyAmount
        counterPartyName
        fxRate
        fees
        reference
      }
    `;

const fetchActivityListQuery = `
      query FetchActivityList(
        $first: Int!
        $cursor: Cursor
        $accountIds: [String!]
        $types: [ActivityFeedItemType!]
        $subTypes: [ActivityFeedItemSubType!]
        $endDate: Datetime
        $securityIds: [String]
        $startDate: Datetime
        $legacyStatuses: [String]
      ) {
        activities(
          first: $first
          after: $cursor
          accountIds: $accountIds
          types: $types
          subTypes: $subTypes
          endDate: $endDate
          securityIds: $securityIds
          startDate: $startDate
          legacyStatuses: $legacyStatuses
        ) {
          edges { node { ...Activity } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

/** API used by the account-specific activity view. */
async function activityList(accountIds, startDate) {
    let transactions = [];
    let hasNextPage = true;
    let cursor = undefined;
    while (hasNextPage) {
        const { data } = await gql(
            "FetchActivityList",
            `${fetchActivityListQuery}\n${activityFeedItemFragment}`,
            { first: 100, cursor, startDate, endDate: new Date().toISOString(), accountIds },
        );
        const activities = data.activities;
        hasNextPage = activities.pageInfo.hasNextPage;
        cursor = activities.pageInfo.endCursor;
        transactions = transactions.concat(activities.edges.map((e) => e.node));
    }
    return transactions;
}

const fetchActivityFeedItemsQuery = `
      query FetchActivityFeedItems(
        $first: Int
        $cursor: Cursor
        $condition: ActivityCondition
        $orderBy: [ActivitiesOrderBy!] = OCCURRED_AT_DESC
      ) {
        activityFeedItems(
          first: $first
          after: $cursor
          condition: $condition
          orderBy: $orderBy
        ) {
          edges { node { ...Activity } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

/** API used by the Activity feed page. */
async function activityFeedItems(accountIds, startDate) {
    let transactions = [];
    let hasNextPage = true;
    let cursor = undefined;
    while (hasNextPage) {
        const { data } = await gql(
            "FetchActivityFeedItems",
            `${fetchActivityFeedItemsQuery}\n${activityFeedItemFragment}`,
            {
                first: 100,
                cursor,
                condition: { startDate, accountIds, unifiedStatuses: ["COMPLETED"] },
            },
        );
        const activities = data.activityFeedItems;
        hasNextPage = activities.pageInfo.hasNextPage;
        cursor = activities.pageInfo.endCursor;
        transactions = transactions.concat(activities.edges.map((e) => e.node));
    }
    return transactions;
}

const fetchAllAccountFinancialsQuery = `
      query FetchAllAccountFinancials(
        $identityId: ID!
        $pageSize: Int = 25
        $cursor: String
      ) {
        identity(id: $identityId) {
          id
          accounts(filter: {}, first: $pageSize, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { cursor node { ...Account } }
          }
        }
      }

      fragment Account on Account {
        id
        unifiedAccountType
        nickname
      }
    `;

/**
 * @typedef {Object} AccountInfo
 * @property {string} id
 * @property {string} nickname
 * @property {string?} unifiedAccountType
 */

function defaultNickname(node) {
    if (node.nickname) return node.nickname;
    const t = node.unifiedAccountType || "";
    const pretty = (x) => ({ NON_REGISTERED: "Non-registered", CRYPTO: "Crypto" })[x] ?? x;
    if (t === "CASH") return "Cash";
    if (t === "CREDIT_CARD") return "Credit Card";
    if (t === "MANAGED_SAVE") return "Save";
    let m;
    if ((m = t.match(/^SELF_DIRECTED_(.+)$/))) return pretty(m[1]);
    if ((m = t.match(/^MANAGED_(?:PORTFOLIO_)?(.+)$/))) return `${pretty(m[1])} (managed)`;
    if ((m = t.match(/^HISA_(?:PORTFOLIO_)?(.+)$/))) return `${pretty(m[1])} savings`;
    return "Unknown";
}

/** Fetches all accounts (paginated). @returns {Promise<AccountInfo[]>} */
async function accountFinancials() {
    const identityId = getOauthCookie()?.identity_canonical_id;
    const nodes = [];
    let hasNextPage = true;
    let cursor = null;
    while (hasNextPage) {
        const { data } = await gql("FetchAllAccountFinancials", fetchAllAccountFinancialsQuery, {
            identityId,
            pageSize: 25,
            cursor,
        });
        const conn = data.identity.accounts;
        nodes.push(...conn.edges.map((e) => e.node));
        hasNextPage = conn.pageInfo.hasNextPage;
        cursor = conn.pageInfo.endCursor;
    }
    return nodes.map((node) => ({
        id: node.id,
        nickname: defaultNickname(node),
        unifiedAccountType: node.unifiedAccountType ?? null,
    }));
}

// Field names for the current account value aren't documented, so try each.
const BALANCE_FIELD_VARIANTS = ["netLiquidationValueV2", "netLiquidationValue"];
let balanceFieldCache = null;

function balancesQuery(field) {
    return `
      query FetchAccountBalances($identityId: ID!, $cursor: String) {
        identity(id: $identityId) {
          id
          accounts(filter: {}, first: 25, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                financials { currentCombined { ${field} { amount currency } } }
              }
            }
          }
        }
      }
    `;
}

/**
 * Fetches each account's current value. Never throws: on failure it returns
 * an empty map and the export falls back to a balance of 0.
 * @returns {Promise<{field: string?, balances: Object, attempts: Object[]}>}
 */
async function fetchBalances() {
    const identityId = getOauthCookie()?.identity_canonical_id;
    const variants = balanceFieldCache ? [balanceFieldCache] : BALANCE_FIELD_VARIANTS;
    const attempts = [];

    for (const field of variants) {
        try {
            const balances = {};
            let hasNextPage = true;
            let cursor = null;
            while (hasNextPage) {
                const { data, errors } = await gql("FetchAccountBalances", balancesQuery(field), {
                    identityId,
                    cursor,
                });
                const conn = data.identity.accounts;
                for (const e of conn.edges) {
                    const money = e.node.financials?.currentCombined?.[field];
                    balances[e.node.id] = money ? { amount: money.amount, currency: money.currency } : null;
                }
                if (errors) attempts.push({ field, partialErrors: errors.map((x) => x.message).slice(0, 5) });
                hasNextPage = conn.pageInfo.hasNextPage;
                cursor = conn.pageInfo.endCursor;
            }
            balanceFieldCache = field;
            console.log(`${LOG} Balances fetched using field "${field}"`);
            return { field, balances, attempts };
        } catch (e) {
            attempts.push({ field, error: String(e).slice(0, 500) });
            console.warn(`${LOG} Balance field "${field}" failed:`, String(e).slice(0, 300));
        }
    }
    console.warn(`${LOG} Could not fetch balances; exports will use a balance of 0`);
    return { field: null, balances: {}, attempts };
}

const fetchFundsTransferQuery = `
      query FetchFundsTransfer($id: ID!) {
        fundsTransfer: funds_transfer(id: $id, include_cancelled: true) {
          id
          status
          source { ...BankAccountOwner }
          destination { ...BankAccountOwner }
        }
      }

      fragment BankAccountOwner on BankAccountOwner {
        bankAccount: bank_account {
          id
          institutionName: institution_name
          nickname
          ...CaBankAccount
          ...UsBankAccount
        }
      }

      fragment CaBankAccount on CaBankAccount {
        accountName: account_name
        accountNumber: account_number
      }

      fragment UsBankAccount on UsBankAccount {
        accountName: account_name
        accountNumber: account_number
      }
    `;

async function fundsTransfer(transferId) {
    const { data } = await gql("FetchFundsTransfer", fetchFundsTransferQuery, { id: transferId });
    return data.fundsTransfer;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Investment accounts get the investment-only features (memo-only trades, etc.). */
function isInvestmentAccountType(t) {
    if (typeof t !== "string" || t === "MANAGED_SAVE") return false; // Save is a cash account
    return t.startsWith("SELF_DIRECTED_") || t.startsWith("MANAGED_");
}

/**
 * OFX account type for the bank/credit-card statement format. Investment
 * accounts are deliberately exported as CHECKING statements so budgeting
 * apps treat them like any other account with a balance.
 */
function ofxBankAccountType(t) {
    if (!t) return "CHECKING";
    if (t.includes("CREDIT")) return "CREDITCARD";
    if (t.includes("SAVING")) return "SAVINGS";
    return "CHECKING";
}

/** OFX date (YYYYMMDDHHMMSS), local time. */
function formatOfxDate(date) {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}000000`;
}

/** YYYY-MM-DD, local time. */
function ymd(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toCents(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function escapeXml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/* ------------------------------------------------------------------ */
/* OFX generation                                                      */
/* ------------------------------------------------------------------ */

function transactionTypeKey(transaction) {
    return transaction.subType ? `${transaction.type}/${transaction.subType}` : transaction.type;
}

function signedAmount(transaction) {
    return transaction.amountSign === "negative" ? `-${transaction.amount}` : String(transaction.amount);
}

/**
 * Describes how a transaction is written to OFX.
 * Returns null for unknown types, {skip: true, reason} when it can't be
 * written, otherwise {payee, memo, trnType, isTrade}.
 * With lookupBanks false, EFT transfers are described without the extra
 * network request (used when only the amount matters).
 */
/** Formats a number with 2 decimals, or up to 4 when it's small (e.g. per-share prices under $1). */
function formatNum(n, maxDecimals = 4) {
    if (!Number.isFinite(n)) return "?";
    const decimals = Math.abs(n) >= 1 ? 2 : maxDecimals;
    return n.toFixed(decimals);
}

/**
 * CAD value of a transaction amount, or null if it can't be determined.
 * Uses Wealthsimple's counterparty amount when it's in CAD, otherwise the
 * fxRate for USD. The rate's direction isn't documented; CAD per USD has
 * always been above 1, so a rate above 1 is treated as CAD per USD and a
 * rate below 1 as USD per CAD.
 */
function cadEquivalent(transaction) {
    const amount = parseFloat(transaction.amount);
    if (!Number.isFinite(amount)) return null;
    if (!transaction.currency || transaction.currency === "CAD") return amount;
    if (transaction.counterPartyCurrency === "CAD" && transaction.counterPartyCurrencyAmount != null) {
        const cp = parseFloat(transaction.counterPartyCurrencyAmount);
        if (Number.isFinite(cp)) return Math.abs(cp);
    }
    const rate = parseFloat(transaction.fxRate);
    if (transaction.currency === "USD" && rate > 0) return rate >= 1 ? amount * rate : amount / rate;
    return null;
}

/**
 * Memo for a buy/sell. Non-registered accounts get the detail needed for
 * adjusted cost base: per-share price, total, currency, FX and fees.
 */
/* ------------------------------------------------------------------ */
/* Order details (USD price, exchange rate)                            */
/* ------------------------------------------------------------------ */

const ORDER_CACHE_KEY = "wsOfxOrderCache";
const ORDER_FIELDS = `id side securityCurrency fillQuantity averageFillPrice filledExchangeRate
    filledNetValue filledValue filledTotalFee filledTaxWithholding`;
// Same query and arguments the site uses on a trade's details screen.
const fetchOrderDetailsQuery = `
  query FetchOrderServiceExtendedOrderActivityDetails($branchId: String!, $externalId: String!) {
    orderServiceExtendedOrderByExternalId(branchId: $branchId, externalId: $externalId) {
      ${ORDER_FIELDS}
    }
  }
`;
let orderLookupBroken = false; // stop retrying after a failure that isn't order-specific

function loadOrderCache() {
    try {
        return JSON.parse(localStorage.getItem(ORDER_CACHE_KEY) || "{}");
    } catch (e) {
        return {};
    }
}

function saveOrderCache(cache) {
    try {
        localStorage.setItem(ORDER_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.warn(`${LOG} Could not save order cache:`, String(e));
    }
}

/**
 * Fetches fill details for an order ("order-..." id). Completed fills never
 * change, so results are cached in the browser and fetched only once.
 * Returns null when unavailable.
 */
async function fetchOrderDetails(orderId, cache) {
    if (!orderId || !orderId.startsWith("order-")) return null;
    if (cache[orderId]) return cache[orderId];
    if (orderLookupBroken) return null;

    try {
        const r = await gql(
            "FetchOrderServiceExtendedOrderActivityDetails",
            fetchOrderDetailsQuery,
            { branchId: "TR", externalId: orderId },
            { strict: false },
        );
        const order = r.data?.orderServiceExtendedOrderByExternalId;
        if (order) {
            if (order.fillQuantity != null && order.averageFillPrice != null) cache[orderId] = order;
            return order;
        }
        const messages = r.errors?.map((e) => e.message) ?? [];
        if (r.status !== 200 || messages.some((m) => /cannot query|unknown|argument|not authorized/i.test(m))) {
            // The query itself is being rejected; don't repeat it for every trade.
            orderLookupBroken = true;
            console.warn(`${LOG} Order details lookup rejected (HTTP ${r.status}); memos fall back to CAD only:`, messages);
        } else {
            console.warn(`${LOG} No order details for ${orderId}:`, messages);
        }
    } catch (e) {
        console.warn(`${LOG} Order details lookup failed for ${orderId}:`, String(e).slice(0, 300));
    }
    return null;
}

function tradeMemo(transaction, action, taxLabel) {
    const qty = parseFloat(transaction.assetQuantity);
    const amount = parseFloat(transaction.amount);
    const currency = transaction.currency || "CAD";
    const sym = transaction.assetSymbol;
    // Quantities arrive padded ("1.0000000000"); round to 4 decimals and drop trailing zeros.
    // Crypto keeps full precision, since amounts like 0.00004 BTC would round to 0.
    const decimals = (transaction.type || "").startsWith("CRYPTO_") ? 8 : 4;
    const qtyText = Number.isFinite(qty) ? String(Number(qty.toFixed(decimals))) : transaction.assetQuantity;
    let memo = `${action} ${qtyText} ${sym}`;

    if (taxLabel !== "non-registered") {
        memo += ` for ${formatNum(amount)} ${currency}`;
        return taxLabel ? `${memo} (${taxLabel})` : memo;
    }

    const order = transaction.__order;
    const secCurrency = order?.securityCurrency;
    const fillPrice = parseFloat(order?.averageFillPrice);
    const rate = parseFloat(order?.filledExchangeRate);
    if (order && secCurrency && secCurrency !== currency && Number.isFinite(fillPrice) && Number.isFinite(rate)) {
        // e.g. "Buy 10 ABC @ 20.00 USD/sh, FX 1.400000 = 280.00 CAD (28.00 CAD/sh)"
        memo += ` @ ${formatNum(fillPrice)} ${secCurrency}/sh, FX ${order.filledExchangeRate}`;
        memo += ` = ${formatNum(amount)} ${currency}`;
        if (qty > 0) memo += ` (${formatNum(amount / qty)} ${currency}/sh)`;
        const orderFee = parseFloat(order.filledTotalFee);
        if (Number.isFinite(orderFee) && orderFee !== 0) memo += `, fees ${formatNum(orderFee)}`;
        const withheld = parseFloat(order.filledTaxWithholding);
        if (Number.isFinite(withheld) && withheld !== 0) memo += `, tax withheld ${formatNum(withheld)}`;
        return `${memo} (${taxLabel})`;
    }

    if (qty > 0) memo += ` @ ${formatNum(amount / qty)} ${currency}/sh`;
    memo += ` = ${formatNum(amount)} ${currency}`;
    if (currency !== "CAD") {
        const cad = cadEquivalent(transaction);
        if (transaction.fxRate != null) memo += `, FX ${transaction.fxRate}`;
        memo += cad != null ? `, ~${formatNum(cad)} CAD` : ", CAD value unknown";
    }
    const fees = parseFloat(transaction.fees);
    if (Number.isFinite(fees) && fees !== 0) memo += `, fees ${formatNum(fees)}`;
    return `${memo} (${taxLabel})`;
}

async function describeTransaction(transaction, accountNicknames, { lookupBanks = true, taxLabel = null } = {}) {
    const type = transactionTypeKey(transaction);
    let payee = "";
    let memo = "";
    let trnType = "OTHER";
    // Dividends and interest: a fixed category the export prefixes with the
    // tax label ("Dividend (non-registered): ABC"), so rules can match it.
    let category = null;
    let detail = "";
    // Direction for types whose amountSign isn't reliable (fees out, rebates in).
    let forceSign = null;

    // Any buy/sell order type, including subtypes not seen yet (e.g. new order kinds).
    // Managed portfolios report MANAGED_BUY / MANAGED_SELL with no subtype.
    const trade = type.match(/^(DIY|CRYPTO|MANAGED)_(BUY|SELL)(?:\/(.+))?$/);
    if (trade) {
        const isBuy = trade[2] === "BUY";
        const action = trade[3] === "DIVIDEND_REINVESTMENT" ? "DRIP buy" : isBuy ? "Buy" : "Sell";
        const kind = trade[1] === "CRYPTO" ? "Crypto" : "Stock";
        return {
            payee: `${kind} - ${transaction.assetSymbol}`,
            memo: tradeMemo(transaction, action, taxLabel),
            trnType: isBuy ? "DEBIT" : "CREDIT",
            isTrade: true,
            tradeSide: isBuy ? "buy" : "sell",
        };
    }

    switch (type) {
        case "INTEREST":
        case "INTEREST/FPL_INTEREST": {
            payee = "Wealthsimple";
            // FPL = fully paid lending (Wealthsimple's stock lending program)
            category = type === "INTEREST/FPL_INTEREST" ? "Stock lending interest" : "Interest";
            if (transaction.currency && transaction.currency !== "CAD") {
                detail = `${transaction.amount} ${transaction.currency}`;
            }
            trnType = "INT";
            break;
        }
        case "REIMBURSEMENT/ATM": {
            payee = "Wealthsimple";
            memo = "ATM Reimbursement";
            trnType = "CREDIT";
            break;
        }
        case "REIMBURSEMENT/CASHBACK": {
            payee = "Wealthsimple";
            memo = "Cash back";
            trnType = "CREDIT";
            break;
        }
        case "P2P_PAYMENT/SEND": {
            payee = transaction.p2pHandle;
            memo = "P2P Payment";
            trnType = "XFER";
            break;
        }
        case "DEPOSIT/E_TRANSFER": {
            payee = transaction.eTransferEmail;
            memo = `INTERAC e-Transfer from ${transaction.eTransferName}`;
            trnType = "XFER";
            break;
        }
        case "WITHDRAWAL/E_TRANSFER": {
            payee = transaction.eTransferEmail;
            memo = `INTERAC e-Transfer to ${transaction.eTransferName}`;
            trnType = "XFER";
            break;
        }
        case "DIVIDEND": // older records have no subtype
        case "DIVIDEND/DIY_DIVIDEND":
        case "DIVIDEND/CASH_DIVIDEND": {
            payee = `Stock - ${transaction.assetSymbol}`;
            category = "Dividend";
            detail = transaction.assetSymbol || "";
            if (transaction.currency && transaction.currency !== "CAD") {
                detail += ` (${transaction.amount} ${transaction.currency})`;
            }
            trnType = "DIV";
            break;
        }
        case "CREDIT_CARD/PURCHASE":
        case "CREDIT_CARD/REFUND": {
            payee = transaction.spendMerchant;
            trnType = "POS";
            break;
        }
        case "CREDIT_CARD/PAYMENT":
        case "CREDIT_CARD_PAYMENT": {
            payee = "Wealthsimple";
            trnType = "PAYMENT";
            break;
        }
        case "DEPOSIT/CHEQUE": {
            memo = "Cheque deposit";
            trnType = "DEP";
            break;
        }
        case "DEPOSIT/AFT": {
            payee = transaction.aftOriginatorName;
            memo = `Direct deposit from ${transaction.aftOriginatorName}`;
            trnType = "DEP";
            break;
        }
        case "WITHDRAWAL/AFT": {
            payee = transaction.aftOriginatorName;
            memo = `Direct deposit to ${transaction.aftOriginatorName}`;
            trnType = "DEBIT";
            break;
        }
        case "DEPOSIT/EFT":
        case "WITHDRAWAL/EFT": {
            const isDeposit = type === "DEPOSIT/EFT";
            trnType = isDeposit ? "DEP" : "DEBIT";
            if (!lookupBanks) break;
            let bankInfo = null;
            try {
                const info = await fundsTransfer(transaction.externalCanonicalId);
                // The external bank is the source for deposits and the destination for withdrawals.
                bankInfo = isDeposit ? info?.source?.bankAccount : info?.destination?.bankAccount;
            } catch (e) {
                console.error(`${LOG} Could not fetch transfer details:`, e);
            }
            if (!bankInfo) return { skip: true, reason: `bank info missing for ${type}` };
            // Skip missing parts so the payee never reads "Bank null ****1234".
            payee = [bankInfo.institutionName, bankInfo.nickname || bankInfo.accountName, bankInfo.accountNumber]
                .filter((x) => x && x !== "null")
                .join(" ");
            memo = isDeposit ? `Direct deposit from ${payee}` : `Direct deposit to ${payee}`;
            break;
        }
        case "INTERNAL_TRANSFER/SOURCE":
        case "INTERNAL_TRANSFER/DESTINATION":
        case "LEGACY_INTERNAL_TRANSFER/SOURCE":
        case "LEGACY_INTERNAL_TRANSFER/DESTINATION": {
            const otherId = transaction.opposingAccountId;
            const isSource = type.endsWith("/SOURCE");
            payee = (otherId && (accountNicknames[otherId] || otherId)) || "Wealthsimple";
            forceSign = isSource ? -1 : 1;
            memo = otherId
                ? `Internal transfer ${isSource ? "to" : "from"} ${payee} (${otherId})`
                : `Internal transfer ${isSource ? "out" : "in"}`;
            trnType = "XFER";
            break;
        }
        case "FEE/MANAGEMENT_FEE": {
            payee = "Wealthsimple";
            category = "Management fee";
            trnType = "FEE";
            forceSign = -1;
            break;
        }
        case "REIMBURSEMENT/ETF_REBATE": {
            payee = "Wealthsimple";
            category = "ETF fee rebate";
            trnType = "CREDIT";
            forceSign = 1;
            break;
        }
        case "REIMBURSEMENT/ACCOUNTING_REIMBURSEMENT": {
            payee = "Wealthsimple";
            category = "Accounting reimbursement";
            trnType = "CREDIT";
            forceSign = 1;
            break;
        }
        case "NON_RESIDENT_TAX": {
            // Foreign (usually US) tax withheld on dividends
            payee = transaction.assetSymbol ? `Stock - ${transaction.assetSymbol}` : "Wealthsimple";
            category = "Foreign tax withheld";
            detail = transaction.assetSymbol || "";
            trnType = "DEBIT";
            forceSign = -1;
            break;
        }
        case "SPEND/PREPAID": {
            payee = transaction.spendMerchant;
            memo = `Prepaid to ${payee}`;
            trnType = "POS";
            break;
        }
        case "WITHDRAWAL/BILL_PAY": {
            payee = transaction.billPayPayeeNickname;
            memo = `Bill payment to ${transaction.billPayCompanyName}`;
            trnType = "PAYMENT";
            break;
        }
        default:
            return null;
    }
    if (category) memo = detail ? `${category}: ${detail}` : category;
    return { payee, memo, trnType, isTrade: false, tradeSide: null, category, detail, forceSign };
}

/**
 * "registered" (TFSA, RRSP, FHSA, ...), "non-registered" (incl. crypto), or
 * null when unknown. Used to label dividends, interest and gains.
 */
function taxTreatment(accountType) {
    if (typeof accountType !== "string") return null;
    if (/NON_REGISTERED|CRYPTO/.test(accountType)) return "non-registered";
    if (/TFSA|RRSP|RESP|RRIF|FHSA|LIRA|LIF|LRSP|RLSP|RDSP|PRIF/.test(accountType)) return "registered";
    return null;
}

/**
 * Order within a day: money coming in (deposits, transfers in, dividends,
 * interest) first, then sells and other outflows, then buys, then the
 * month-end gain/loss entry.
 */
/**
 * Signed amount as exported. Trades take their direction from the side and
 * fees/rebates from their type, because amountSign isn't reliable for them.
 */
function exportAmount(transaction, info, zeroTrades) {
    // Some older records (e.g. legacy internal transfers) come with no amount.
    // Write 0.00 rather than "null"; the monthly gain entry absorbs the value.
    if (!Number.isFinite(parseFloat(transaction.amount))) return "0.00";
    if (info.isTrade) {
        if (zeroTrades) return "0.00";
        return `${info.tradeSide === "buy" ? "-" : ""}${transaction.amount}`;
    }
    if (info.forceSign) {
        const abs = String(transaction.amount).replace(/^-/, "");
        return info.forceSign < 0 ? `-${abs}` : abs;
    }
    return signedAmount(transaction);
}

function sortRank(info, amount) {
    if (info.isTrade) return info.tradeSide === "buy" ? 2 : 1;
    return String(amount).startsWith("-") ? 1 : 0;
}
const GAIN_RANK = 3;

function compareEntries(a, b) {
    const da = ymd(a.date);
    const db = ymd(b.date);
    if (da !== db) return da < db ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.date - b.date;
}

/* ------------------------------------------------------------------ */
/* Monthly market gain/loss (investment accounts)                      */
/* ------------------------------------------------------------------ */

function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMoney(cents) {
    return (cents / 100).toFixed(2);
}

/**
 * Daily account values (net liquidation value), oldest first, as
 * [[ "YYYY-MM-DD", cents ], ...]. Fetched in chunks so no single
 * request needs pagination.
 */
async function fetchDailyValues(accountId, start, end) {
    const points = new Map();
    let chunkStart = start;
    while (ymd(chunkStart) <= ymd(end)) {
        let chunkEnd = addDays(chunkStart, 299);
        if (ymd(chunkEnd) > ymd(end)) chunkEnd = end;
        const query = `
          query FetchAccountDailyValues {
            account(id: ${JSON.stringify(accountId)}) {
              id
              financials {
                historicalDaily(currency: CAD, startDate: "${ymd(chunkStart)}", endDate: "${ymd(chunkEnd)}", first: 400) {
                  edges { node { date netLiquidationValueV2 { amount currency } } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        `;
        const { data } = await gql("FetchAccountDailyValues", query);
        const conn = data.account?.financials?.historicalDaily;
        for (const e of conn?.edges ?? []) {
            const money = e.node.netLiquidationValueV2;
            if (e.node.date && money?.amount != null) points.set(e.node.date, toCents(money.amount));
        }
        if (conn?.pageInfo?.hasNextPage) {
            console.warn(`${LOG} Daily values for ${accountId} were truncated between ${ymd(chunkStart)} and ${ymd(chunkEnd)}`);
        }
        chunkStart = addDays(chunkEnd, 1);
    }
    return [...points.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Value on the last day with data on or before dateStr, or null if none. */
function valueOnOrBefore(points, dateStr) {
    let result = null;
    for (const [date, cents] of points) {
        if (date > dateStr) break;
        result = cents;
    }
    return result;
}

/**
 * Builds one "Market gain/loss" entry per completed month:
 *   gain = value at month end - value at previous month end - exported cash flows in the month
 * where trades count as 0 (they're memo-only). Each entry has a stable FITID
 * (mtm-<account>-<YYYY-MM>) so re-exporting never duplicates it.
 *
 * Months covered: every completed month whose last day is on or after the
 * day before the export's start date (so "This Month" also books last month).
 * With "All", every completed month since the account's first transaction.
 */
async function computeMonthlyGainEntries({ accountId, transactions, fromDate, accountNicknames, taxLabel }) {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let firstMonthStart;
    if (fromDate) {
        const cutoff = addDays(fromDate, -1);
        firstMonthStart = new Date(cutoff.getFullYear(), cutoff.getMonth(), 1);
    } else {
        if (!transactions.length) return { entries: [], months: 0 };
        const earliest = new Date(Math.min(...transactions.map((t) => new Date(t.occurredAt).getTime())));
        firstMonthStart = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    }
    if (firstMonthStart >= thisMonthStart) return { entries: [], months: 0 };

    // Cash flows must cover whole months, which may start before the export range.
    let flowTransactions = transactions;
    if (fromDate && firstMonthStart < fromDate) {
        flowTransactions = await activityFeedItems([accountId], firstMonthStart);
    }
    const flows = {};
    for (const t of flowTransactions) {
        const date = new Date(t.occurredAt);
        if (date < firstMonthStart || date >= thisMonthStart) continue;
        const info = await describeTransaction(t, accountNicknames, { lookupBanks: false });
        if (!info || info.skip) continue; // Not exported, so not part of the ledger either.
        const cents = toCents(exportAmount(t, info, true));
        const key = monthKey(date);
        flows[key] = (flows[key] || 0) + cents;
    }

    const lastCompletedDay = addDays(thisMonthStart, -1);
    const points = await fetchDailyValues(accountId, addDays(firstMonthStart, -10), lastCompletedDay);

    const entries = [];
    let months = 0;
    // Running ledger total (cash flows + gains booked so far) since firstMonthStart.
    // Used as the starting value when Wealthsimple has no daily value for the
    // previous month, e.g. for months older than its value history.
    let ledger = 0;
    const monthsWithoutHistory = [];
    const reconRows = [];

    // Opening balance: Wealthsimple's activity feed doesn't return older
    // records for some accounts (e.g. nothing before April 2023), but the
    // account may already have held money then. For "All" exports, start the
    // ledger at the account's value the day before the earliest transaction.
    let openingCents = 0;
    if (!fromDate) {
        const openingDate = addDays(firstMonthStart, -1);
        const opening = valueOnOrBefore(points, ymd(openingDate));
        if (opening && opening > 0) {
            // Found either way, so the summary can show it; only written when enabled.
            openingCents = opening;
            ledger = opening;
        }
        if (opening && opening > 0 && wsOfxExportSettings.openingBalance) {
            entries.push({
                date: openingDate,
                trnType: "CREDIT",
                amount: formatMoney(opening),
                fitid: `open-${accountId}`,
                payee: `Opening balance${taxLabel ? ` (${taxLabel})` : ""}`,
                rank: 0,
                memo:
                    `Opening balance${taxLabel ? ` (${taxLabel})` : ""}: account value on ${ymd(openingDate)}, ` +
                    `before the earliest transaction Wealthsimple returns`,
            });
        }
    }
    for (let m = firstMonthStart; m < thisMonthStart; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        const key = monthKey(m);
        const flow = flows[key] || 0;
        const endValue = valueOnOrBefore(points, ymd(monthEnd));
        if (endValue === null) {
            // No value yet: either the account didn't exist, or the history
            // doesn't reach back this far. Carry the flows forward.
            if (flow !== 0) monthsWithoutHistory.push(key);
            ledger += flow;
            continue;
        }
        const prevValueRaw = valueOnOrBefore(points, ymd(addDays(m, -1)));
        // With a previous value, start from it. Without one, start from the
        // ledger so earlier flows aren't counted as gains. Exact for "All"
        // exports, where the ledger covers every transaction.
        const prevValue = prevValueRaw ?? ledger;
        const gain = endValue - prevValue - flow;
        ledger = endValue;
        months++;
        reconRows.push({
            monthEnd: ymd(monthEnd),
            startValue: formatMoney(prevValue),
            cashFlows: formatMoney(flow),
            gainEntry: formatMoney(gain),
            // After this month's gain entry, the app's balance should equal this
            appShouldShow: formatMoney(endValue),
        });
        if (gain === 0) continue;
        entries.push({
            date: monthEnd,
            trnType: gain > 0 ? "CREDIT" : "DEBIT",
            amount: formatMoney(gain),
            fitid: `mtm-${accountId}-${key}`,
            payee: `Market ${gain > 0 ? "gain" : "loss"}${taxLabel ? ` (${taxLabel})` : ""}`,
            rank: GAIN_RANK,
            memo:
                `Market ${gain > 0 ? "gain" : "loss"}${taxLabel ? ` (${taxLabel})` : ""}: ${key}, ` +
                `value ${formatMoney(prevValue)} to ${formatMoney(endValue)}, net cash flows ${formatMoney(flow)}` +
                (prevValueRaw === null && prevValue !== 0 ? " (start = earlier cash flows; no value history before this month)" : ""),
        });
    }
    if (monthsWithoutHistory.length) {
        console.warn(
            `${LOG} ${accountId}: no daily values for ${monthsWithoutHistory.length} month(s) with transactions ` +
                `(${monthsWithoutHistory[0]} to ${monthsWithoutHistory[monthsWithoutHistory.length - 1]}). ` +
                `Gains for those months are combined into the first month that has a value.`,
        );
    }
    return {
        entries,
        months,
        openingCents,
        reconRows,
        historyFrom: points.length ? points[0][0] : null,
        monthsWithoutHistory: monthsWithoutHistory.length,
    };
}

/* ------------------------------------------------------------------ */
/* Statement assembly                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {Transaction[]} transactions
 * @param {AccountInfo[]} accountsInfo
 * @param {Object} balances - account id -> {amount, currency} | null
 * @param {string} rangeLabel
 * @param {Date?} fromDate
 * @param {string[]} accountIds - accounts selected for this export
 * @returns {Promise<Object>} account id -> Blob
 */
async function transactionsToOfxBlobs(transactions, accountsInfo, balances, rangeLabel, fromDate, accountIds) {
    const accountsById = Object.fromEntries(accountsInfo.map((a) => [a.id, a]));
    const accountNicknames = Object.fromEntries(accountsInfo.map((a) => [a.id, a.nickname]));

    const accTransactions = transactions.reduce((acc, t) => {
        (acc[t.accountId] = acc[t.accountId] || []).push(t);
        return acc;
    }, {});

    // Selected investment accounts get a file even without transactions in
    // the range, so last month's gain/loss entry isn't missed.
    if (wsOfxExportSettings.monthlyMarketGains) {
        for (const id of accountIds || []) {
            if (!accTransactions[id] && isInvestmentAccountType(accountsById[id]?.unifiedAccountType)) {
                accTransactions[id] = [];
            }
        }
    }

    const unknownTypes = {};
    const summaries = [];
    const accBlobs = {};
    for (const accountId in accTransactions) {
        try {
            const result = await accountTransactionsToOfxBlob({
                transactions: accTransactions[accountId],
                accountId,
                account: accountsById[accountId],
                accountNicknames,
                balance: balances[accountId] ?? null,
                unknownTypes,
                fromDate,
            });
            if (!result) continue; // Nothing to write
            accBlobs[accountId] = result.blob;
            summaries.push(result.summary);
        } catch (e) {
            console.error(`${LOG} Failed to build file for ${accountId}:`, e);
        }
    }

    console.log(`${LOG} Per-account summary (range: ${rangeLabel}):`);
    console.table(summaries);
    if (rangeLabel !== "All") {
        console.log(
            `${LOG} Note: "gapToBalance" is only meaningful for the "All" range, since shorter ranges omit earlier history.`,
        );
    }
    if (Object.keys(unknownTypes).length) {
        console.warn(`${LOG} Skipped unknown transaction types (count):`, unknownTypes);
    }
    return accBlobs;
}

function stmtTrnToOfx(e) {
    let { payee, memo } = e;
    if (wsOfxExportSettings.swapMemoPayee) [payee, memo] = [memo, payee];
    let s = `<STMTTRN>
<TRNTYPE>${e.trnType}
<DTPOSTED>${formatOfxDate(e.date)}
<TRNAMT>${e.amount}
<FITID>${escapeXml(e.fitid)}
`;
    if (payee) s += `<NAME>${escapeXml(payee)}\n`;
    if (memo) s += `<MEMO>${escapeXml(memo)}\n`;
    s += `</STMTTRN>
`;
    return s;
}

/**
 * @returns {Promise<{blob: Blob, summary: Object}?>} null when there's nothing to write
 */
async function accountTransactionsToOfxBlob({
    transactions,
    accountId,
    account,
    accountNicknames,
    balance,
    unknownTypes,
    fromDate,
}) {
    const nowStr = formatOfxDate(new Date());
    const accountType = account?.unifiedAccountType ?? null;
    const isInvestment = isInvestmentAccountType(accountType);

    // Prefer the real account type; only guess from transactions if it's missing.
    let ofxAccountType;
    if (accountType) {
        ofxAccountType = ofxBankAccountType(accountType);
    } else {
        ofxAccountType = transactions.some((t) => t.type === "CREDIT_CARD") ? "CREDITCARD" : "CHECKING";
        console.warn(`${LOG} No account type for ${accountId}; guessed ${ofxAccountType}`);
    }
    const isCreditCard = ofxAccountType === "CREDITCARD";
    const zeroTrades = isInvestment && wsOfxExportSettings.tradesAsMemoOnly;
    const taxLabel = isInvestment ? taxTreatment(accountType) : null;

    transactions.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    // Non-registered stock trades: look up fill details for USD price and FX.
    let ordersLooked = 0;
    let ordersFound = 0;
    if (taxLabel === "non-registered") {
        const cache = loadOrderCache();
        for (const t of transactions) {
            if (!/^DIY_(?:BUY|SELL)$/.test(t.type)) continue;
            ordersLooked++;
            const order = await fetchOrderDetails(t.externalCanonicalId, cache);
            if (order) {
                t.__order = order;
                ordersFound++;
            }
        }
        saveOrderCache(cache);
    }

    const entries = [];
    const stats = { exported: 0, tradesZeroed: 0, skipped: 0, nonCadCurrency: 0, sumCents: 0 };

    for (const transaction of transactions) {
        const date = new Date(transaction.occurredAt);
        const dateStr = formatOfxDate(date);
        const type = transactionTypeKey(transaction);

        const info = await describeTransaction(transaction, accountNicknames, { taxLabel });
        if (!info) {
            console.error(`${LOG} ${dateStr} transaction [${type}] has unexpected type, skipping it.`, transaction);
            unknownTypes[type] = (unknownTypes[type] || 0) + 1;
            stats.skipped++;
            continue;
        }
        if (info.skip) {
            console.error(`${LOG} ${dateStr} ${info.reason}, skipping:`, transaction);
            stats.skipped++;
            continue;
        }

        if (transaction.currency && transaction.currency !== "CAD") stats.nonCadCurrency++;

        const amount = exportAmount(transaction, info, zeroTrades);
        const amountMissing = !Number.isFinite(parseFloat(transaction.amount));
        if (amountMissing) {
            stats.amountMissing = (stats.amountMissing || 0) + 1;
            console.warn(`${LOG} ${dateStr} ${type} has no amount from Wealthsimple; exported as 0.00`, transaction);
        }
        if (info.isTrade && zeroTrades) stats.tradesZeroed++;
        stats.sumCents += toCents(amount);
        stats.exported++;

        let memo = info.memo;
        if (taxLabel && info.category) {
            const head = `${info.category} (${taxLabel})`;
            memo = info.detail ? `${head}: ${info.detail}` : head;
        }

        if (amountMissing) memo = `${memo || ""} (amount not provided by Wealthsimple)`.trim();

        entries.push({
            date,
            rank: sortRank(info, amount),
            trnType: info.trnType,
            amount,
            fitid: transaction.canonicalId || `${date.getTime()}-${Math.random().toString(36).slice(2, 11)}`,
            payee: info.payee,
            memo,
        });
    }

    if (wsOfxExportSettings.logRawTrades) {
        const raw = transactions.filter((t) => /^(?:DIY|CRYPTO|MANAGED)_(?:BUY|SELL)$|^DIVIDEND$/.test(t.type));
        console.log(
            `${LOG} Raw trade and dividend records for ${account?.nickname ?? accountId} (${raw.length}):\n` +
                "----- BEGIN RAW TRADES -----\n" +
                JSON.stringify(raw, null, 2) +
                "\n----- END RAW TRADES -----",
        );
    }

    const fxRecords = transactions.filter(
        (t) => (t.currency && t.currency !== "CAD") || t.fxRate != null || t.counterPartyCurrency != null,
    );
    if (fxRecords.length) {
        console.log(`${LOG} ${account?.nickname ?? accountId}: transactions with currency/FX data (for checking conversions):`);
        console.table(
            fxRecords.map((t) => ({
                date: t.occurredAt?.slice(0, 10),
                type: transactionTypeKey(t),
                symbol: t.assetSymbol,
                qty: t.assetQuantity,
                amount: t.amount,
                sign: t.amountSign,
                currency: t.currency,
                fxRate: t.fxRate,
                fees: t.fees,
                counterPartyCurrency: t.counterPartyCurrency,
                counterPartyCurrencyAmount: t.counterPartyCurrencyAmount,
                computedCad: cadEquivalent(t),
            })),
        );
    }

    // Monthly market gain/loss entries
    let gain = { entries: [], months: 0, sumCents: 0, openingCents: 0, status: "n/a" };
    if (isInvestment && wsOfxExportSettings.monthlyMarketGains) {
        if (!zeroTrades) {
            gain.status = "off: needs 'Trades as memo only'";
            console.warn(`${LOG} Monthly gain/loss for ${accountId} needs "Trades as memo only" turned on; skipping`);
        } else {
            try {
                const r = await computeMonthlyGainEntries({ accountId, transactions, fromDate, accountNicknames, taxLabel });
                gain = {
                    entries: r.entries,
                    months: r.months,
                    historyFrom: r.historyFrom,
                    monthsWithoutHistory: r.monthsWithoutHistory,
                    sumCents: r.entries
                        .filter((e) => !e.fitid.startsWith("open-"))
                        .reduce((s, e) => s + toCents(e.amount), 0),
                    openingCents: r.openingCents || 0,
                };
                if (r.reconRows.length) {
                    console.log(
                        `${LOG} Reconciliation for ${account?.nickname ?? accountId}: after each month's gain entry, ` +
                            `your app's balance should equal "appShouldShow"` +
                            (r.openingCents
                                ? `. Starting balance assumed on the day before ${r.reconRows[0].monthEnd.slice(0, 7)}: ` +
                                  `${formatMoney(r.openingCents)}${wsOfxExportSettings.openingBalance ? " (opening entry in file)" : " (must already be in your app)"}`
                                : ""),
                    );
                    console.table(r.reconRows);
                }
                gain = {
                    ...gain,
                    status: "ok",
                };
            } catch (e) {
                gain.status = "failed";
                console.error(`${LOG} Monthly gain/loss failed for ${accountId}; exporting without it:`, e);
            }
        }
    }
    entries.push(...gain.entries);

    if (!entries.length) return null;
    entries.sort(compareEntries);
    const startDate = formatOfxDate(entries[0].date);
    const endDate = formatOfxDate(entries[entries.length - 1].date);

    let ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:UTF-8
CHARSET:UTF-8
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>${nowStr}
<LANGUAGE>ENG
<FI>
<ORG>Wealthsimple
<FID>0
</FI>
</SONRS>
</SIGNONMSGSRSV1>
`;

    if (isCreditCard) {
        ofx += `<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>${Date.now()}
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<CCSTMTRS>
<CURDEF>CAD
<CCACCTFROM>
<ACCTID>${escapeXml(accountId)}
</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>${startDate}
<DTEND>${endDate}
`;
    } else {
        ofx += `<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>${Date.now()}
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>CAD
<BANKACCTFROM>
<BANKID>Wealthsimple
<ACCTID>${escapeXml(accountId)}
<ACCTTYPE>${ofxAccountType}
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>${startDate}
<DTEND>${endDate}
`;
    }

    for (const e of entries) ofx += stmtTrnToOfx(e);

    // Ledger balance: real account value for non-credit-card accounts.
    let balAmt = "0";
    if (!isCreditCard) {
        if (balance && balance.amount != null) {
            balAmt = formatMoney(toCents(balance.amount));
            if (balance.currency && balance.currency !== "CAD") {
                console.warn(`${LOG} ${accountId} balance is in ${balance.currency}, but the file says CAD`);
            }
        } else {
            console.warn(`${LOG} No balance available for ${accountId}; writing 0`);
        }
    }

    if (isCreditCard) {
        ofx += `</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${balAmt}
<DTASOF>${nowStr}
</LEDGERBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;
    } else {
        ofx += `</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${balAmt}
<DTASOF>${nowStr}
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    }

    const summary = {
        account: account?.nickname ?? "?",
        id: accountId,
        unifiedAccountType: accountType,
        investment: isInvestment,
        tax: taxLabel ?? "-",
        orderDetails: ordersLooked ? `${ordersFound}/${ordersLooked}` : "-",
        fetched: transactions.length,
        exported: stats.exported,
        tradesZeroed: stats.tradesZeroed,
        skipped: stats.skipped,
        noAmount: stats.amountMissing || 0,
        nonCad: stats.nonCadCurrency,
        sumOfExported: formatMoney(stats.sumCents),
        gainStatus: gain.status,
        firstTransaction: transactions.length ? ymd(new Date(transactions[0].occurredAt)) : "-",
        valuesFrom: gain.historyFrom ?? "-",
        monthsNoValues: gain.monthsWithoutHistory ?? 0,
        gainMonths: gain.months,
        gainEntries: gain.entries.length,
        sumOfGains: formatMoney(gain.sumCents),
        ledgerBalance: balAmt,
        // When off, this is the balance the app should already hold before the earliest transaction.
        openingBalance: gain.openingCents
            ? `${wsOfxExportSettings.openingBalance ? "" : "off: "}${formatMoney(gain.openingCents)}`
            : "-",
        gapToBalance: isCreditCard
            ? "n/a"
            : formatMoney(toCents(balAmt) - stats.sumCents - gain.sumCents - (gain.openingCents || 0)),
    };

    return { blob: new Blob([ofx], { type: "application/x-ofx" }), summary };
}

function saveBlobsToFiles(accountBlobs) {
    for (const acc in accountBlobs) {
        const blobUrl = URL.createObjectURL(accountBlobs[acc]);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${acc}.ofx`;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Candidate queries for historical daily account values. These are guesses;
 * the error messages they produce are what we need to see.
 */
function historyProbes(accountId, identityId, startDate, endDate) {
    const acct = JSON.stringify(accountId);
    const ident = JSON.stringify(identityId);
    const range = `startDate: "${startDate}", endDate: "${endDate}"`;
    const conn = (valueField, depositField) => `
        edges { node { date ${valueField} { amount currency } ${depositField} { amount currency } } }
        pageInfo { hasNextPage endCursor }`;
    return [
        {
            name: "A: account.financials.historicalDaily(currency: CAD), V2 fields",
            op: "OfxProbeHistoryA",
            query: `query OfxProbeHistoryA { account(id: ${acct}) { id financials {
                historicalDaily(currency: CAD, ${range}, first: 120) { ${conn("netLiquidationValueV2", "netDepositsV2")} } } } }`,
        },
        {
            name: "B: same as A without currency argument",
            op: "OfxProbeHistoryB",
            query: `query OfxProbeHistoryB { account(id: ${acct}) { id financials {
                historicalDaily(${range}, first: 120) { ${conn("netLiquidationValueV2", "netDepositsV2")} } } } }`,
        },
        {
            name: "C: same as A with non-V2 fields",
            op: "OfxProbeHistoryC",
            query: `query OfxProbeHistoryC { account(id: ${acct}) { id financials {
                historicalDaily(currency: CAD, ${range}, first: 120) { ${conn("netLiquidationValue", "netDeposits")} } } } }`,
        },
        {
            name: "D: identity.financials(filter: {accounts}).historicalDaily(currency: CAD)",
            op: "OfxProbeHistoryD",
            query: `query OfxProbeHistoryD { identity(id: ${ident}) { id financials(filter: { accounts: [${acct}] }) {
                historicalDaily(currency: CAD, ${range}, first: 120) { ${conn("netLiquidationValueV2", "netDepositsV2")} } } } }`,
        },
    ];
}

function summarizeHistory(data) {
    const c = data?.account?.financials?.historicalDaily ?? data?.identity?.financials?.historicalDaily;
    if (!c) return null;
    const edges = c.edges ?? [];
    return {
        points: edges.length,
        first: edges.slice(0, 3).map((e) => e.node),
        last: edges.slice(-3).map((e) => e.node),
        pageInfo: c.pageInfo ?? null,
    };
}

const introspectionProbe = `
  query OfxProbeIntrospection {
    account: __type(name: "Account") { fields { name } }
    accountFinancials: __type(name: "AccountFinancials") { fields { name args { name } } }
    identityFinancials: __type(name: "IdentityFinancials") { fields { name args { name } } }
  }
`;

function summarizeIntrospection(data) {
    if (!data) return null;
    const out = {};
    for (const key of Object.keys(data)) {
        const fields = data[key]?.fields;
        out[key] = fields
            ? fields.map((f) => (f.args?.length ? `${f.name}(${f.args.map((a) => a.name).join(", ")})` : f.name))
            : null;
    }
    return out;
}

/**
 * Collects everything needed to build monthly gain/loss entries and logs it
 * as one JSON block. Includes account IDs, nicknames and balances, but never
 * the access token.
 */
async function runDiagnostics() {
    const tag = `${LOG}[diag]`;
    const report = {
        scriptVersion: SCRIPT_VERSION,
        page: window.location.pathname,
        timestamp: new Date().toISOString(),
        settings: { ...wsOfxExportSettings },
    };
    console.log(`${tag} Starting diagnostics…`);

    try {
        const accounts = await accountFinancials();
        const { field, balances, attempts } = await fetchBalances();
        report.balanceField = field;
        report.balanceAttempts = attempts;
        report.accounts = accounts.map((a) => ({
            id: a.id,
            nickname: a.nickname,
            unifiedAccountType: a.unifiedAccountType,
            investment: isInvestmentAccountType(a.unifiedAccountType),
            ofxType: ofxBankAccountType(a.unifiedAccountType),
            balance: balances[a.id] ?? null,
        }));
        console.table(report.accounts);

        const identityId = getOauthCookie()?.identity_canonical_id;
        const investmentAccounts = accounts.filter((a) => isInvestmentAccountType(a.unifiedAccountType));
        report.history = {};

        if (!investmentAccounts.length) {
            report.history.note = "No investment accounts detected from unifiedAccountType";
        } else {
            const sample = investmentAccounts[0];
            const end = ymd(new Date());
            const start = ymd(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
            report.history.sampleAccount = { id: sample.id, type: sample.unifiedAccountType };
            report.history.range = { start, end };
            report.history.probes = [];

            for (const p of historyProbes(sample.id, identityId, start, end)) {
                try {
                    const r = await gql(p.op, p.query, {}, { strict: false });
                    report.history.probes.push({
                        name: p.name,
                        status: r.status,
                        errors: r.errors ? r.errors.map((e) => e.message).slice(0, 5) : null,
                        result: summarizeHistory(r.data),
                        nonJsonBody: r.rawText,
                    });
                } catch (e) {
                    report.history.probes.push({ name: p.name, exception: String(e).slice(0, 500) });
                }
            }
        }

        // Sample raw trade/dividend records from self-directed accounts: every
        // record with non-CAD or FX data (up to 10) plus the 5 latest CAD trades.
        report.rawTrades = {};
        const sampleTrades = [];
        for (const a of accounts.filter((x) => (x.unifiedAccountType || "").startsWith("SELF_DIRECTED_"))) {
            try {
                const all = await activityFeedItems([a.id], null);
                const relevant = all.filter((t) => /^(?:DIY|CRYPTO|MANAGED)_(?:BUY|SELL)$|^DIVIDEND$/.test(t.type));
                const isFx = (t) =>
                    (t.currency && t.currency !== "CAD") || t.fxRate != null || t.counterPartyCurrency != null;
                const fx = relevant.filter(isFx).slice(0, 10);
                const cadTrades = relevant.filter((t) => !isFx(t) && /_(?:BUY|SELL)$/.test(t.type)).slice(0, 5);
                const strip = (t) => {
                    const { identityId, ...rest } = t;
                    return rest;
                };
                sampleTrades.push(...relevant.filter((t) => /_(?:BUY|SELL)$/.test(t.type)).slice(0, 3));
                report.rawTrades[a.nickname] = {
                    totalTradesAndDividends: relevant.length,
                    withFxData: fx.map(strip),
                    latestCadTrades: cadTrades.map(strip),
                };
            } catch (e) {
                report.rawTrades[a.nickname] = { error: String(e).slice(0, 300) };
            }
        }

        // Probe for order details (USD price, exchange rate) and security currency.
        // These query names are guesses; their error messages are what we need.
        report.orderProbes = [];
        const probeRun = async (name, op, query) => {
            try {
                const r = await gql(op, query, {}, { strict: false });
                report.orderProbes.push({
                    name,
                    status: r.status,
                    errors: r.errors ? r.errors.map((e) => e.message).slice(0, 8) : null,
                    data: r.data ? JSON.stringify(r.data).slice(0, 3000) : null,
                });
            } catch (e) {
                report.orderProbes.push({ name, exception: String(e).slice(0, 500) });
            }
        };
        for (const t of sampleTrades.slice(0, 3)) {
            const ext = JSON.stringify(t.externalCanonicalId || "");
            const sec = JSON.stringify(t.securityId || "");
            await probeRun(
                `order ${t.assetSymbol} (${t.externalCanonicalId}): soOrdersExtendedOrder`,
                "OfxProbeOrder",
                `query OfxProbeOrder { soOrdersExtendedOrder(branchId: "TR", externalId: ${ext}) {
                    averageFilledPrice filledExchangeRate filledQuantity filledTotalFee
                    securityCurrency submittedExchangeRate submittedNetValue status } }`,
            );
            await probeRun(
                `security ${t.assetSymbol} (${t.securityId})`,
                "OfxProbeSecurity",
                `query OfxProbeSecurity { security(id: ${sec}) { id currency stock { symbol name primaryExchange } } }`,
            );
        }

        try {
            const r = await gql("OfxProbeIntrospection", introspectionProbe, {}, { strict: false });
            report.introspection = {
                status: r.status,
                errors: r.errors ? r.errors.map((e) => e.message).slice(0, 5) : null,
                types: summarizeIntrospection(r.data),
            };
        } catch (e) {
            report.introspection = { exception: String(e).slice(0, 500) };
        }
    } catch (e) {
        report.fatalError = String(e).slice(0, 1000);
    }

    // Order probes get their own short message so a long report can't hide them.
    console.log(
        `${tag} v${SCRIPT_VERSION} order probes:\n` +
            "----- BEGIN ORDER PROBES -----\n" +
            JSON.stringify(report.orderProbes ?? { missing: true, fatalError: report.fatalError ?? null }, null, 2) +
            "\n----- END ORDER PROBES -----",
    );

    console.log(
        "----- BEGIN OFX-EXPORT DIAGNOSTICS -----\n" +
            JSON.stringify(report, null, 2) +
            "\n----- END OFX-EXPORT DIAGNOSTICS -----",
    );
    console.log(`${tag} Done. Copy the block between the BEGIN/END markers.`);
    return report;
}
