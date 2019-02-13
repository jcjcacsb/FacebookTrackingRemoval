/*  This file is part of FacebookTrackingRemoval.

    FacebookTrackingRemoval is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    FacebookTrackingRemoval is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with FacebookTrackingRemoval.  If not, see <http://www.gnu.org/licenses/>.

    Copyright (C) 2016-2019 Michael Ziminsky
*/

'use strict';

const STATIC_RULE_FILES = ["suggestions", "sponsored", "pending"];
const DYN_RULE_FILES = ["content", "content_pending"];
const DATE_HEADER = "last-modified";
const RATE_LIMIT = (1000 * 60 * 5); // 5 min

function shouldSkip(newDateString, oldDateString) {
    const newDate = Date.parse(newDateString);
    const oldDate = Date.parse(oldDateString);

    // New value failed lookup, don't replace cached value
    if (isNaN(newDate) && !isNaN(oldDate))
        return true;

    // Failed to get new value, but nothing cached, use fallback
    if (isNaN(newDate) && isNaN(oldDate))
        return false;

    // Lookup succeeded, no cache, use new.
    if (!isNaN(newDate) && isNaN(oldDate))
        return false;

    // Skip unless new value is more recent than old
    return newDate <= oldDate;
}

async function refreshRules({ force = false, check = false } = {}) {
    const {hide_rules: currentRules = {}} = await browser.storage.local.get("hide_rules");
    const devMode = (await browser.management.getSelf()).installType === "development";

    // Prevent abuse, max refresh once per 5 min
    const timeout = devMode
        ? 0
        : RATE_LIMIT - (Date.now() - Date.parse(currentRules.lastRefresh));

    if (check)
        return Promise.resolve(timeout > 0 ? timeout : 0);

    if (timeout > 0)
        return Promise.reject(timeout);

    const fetchRule = async file => {
        const current = currentRules[file] || {};
        const resp = await fetch(`https://${devMode ? "localhost" : "mgziminsky.gitlab.io"}/FacebookTrackingRemoval/${file}`, { mode: 'cors' })
            .then(resp => resp && resp.ok ? resp : Promise.reject())
            .catch(_ => current ? new Response(current.selector, {headers: {[DATE_HEADER]: current[DATE_HEADER]}}) : Promise.reject()) // Use saved value if present
            .catch(_ => fetch(browser.runtime.getURL(`src/hide_rules/${file}`))); // Fallback to bundled copy as last resort, should never fail if file is present

        if (!resp.ok || !force && shouldSkip(resp.headers.get(DATE_HEADER), (current || {})[DATE_HEADER]))
            return null; // No updates, or no file

        return resp;
    };

    const newRules = {};
    for (let file of STATIC_RULE_FILES) {
        const resp = await fetchRule(file);

        if (resp === null)
            continue;

        newRules[file] = {
            selector: await resp.text().then(joinSelectors),
            [DATE_HEADER]: resp.headers.get(DATE_HEADER),
        };
    }

    for (let file of DYN_RULE_FILES) {
        const resp = await fetchRule(file);

        if (resp === null)
            continue;

        const rules = {};
        const lines = (await resp.text()).trim().replace(/\s*\/\*.*\*\/\s*/g, "").split(/\s*$\s*/m);
        for (let line of lines) {
            const [sel, ...filters] = line.split("||");
            if (filters.length < 1)
                continue;
            for (let k of filters.map(normalizeString)) {
                if (!rules.hasOwnProperty(k))
                    rules[k] = [];
                rules[k].push(sel.trim());
            }
        }

        if (rules.length == 0)
            continue;

        for (let k in rules)
            rules[k] = rules[k].join(',');

        newRules[file] = {
            selector: rules,
            [DATE_HEADER]: resp.headers.get(DATE_HEADER),
        };
    }

    browser.storage.local.set({
        hide_rules: Object.assign(currentRules, newRules, {lastRefresh: new Date().toUTCString()}),
    }).then(() => RATE_LIMIT);
}
