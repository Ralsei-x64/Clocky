"use strict";

const pageNames = { clock: "Clock", media: "Media Player", usage: "AI Tokens", stats: "System Stats" };

function pageLayout(settings) {
    const rows = new Map();
    for (const row of Array.isArray(settings?.pages) ? settings.pages : []) {
        if (Object.hasOwn(pageNames, row?.id) && !rows.has(row.id)) rows.set(row.id, row.enabled !== false);
    }
    // Preserve the blank Infobar in profiles that turned every original page off.
    const legacyBlank = ["clock", "media", "usage"].every((id) => rows.get(id) === false);
    for (const id of Object.keys(pageNames)) {
        if (!rows.has(id)) rows.set(id, !legacyBlank);
    }
    return Array.from(rows, ([id, enabled]) => ({ id, enabled }));
}

function defaultPageFor(preferred, enabled) {
    return enabled.includes(preferred) ? preferred : enabled[0];
}

if (typeof module === "object") module.exports = { pageNames, pageLayout, defaultPageFor };
