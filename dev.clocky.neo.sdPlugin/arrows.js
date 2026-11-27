"use strict";

function arrowColor(settings) {
    const value = settings?.color;
    return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : "#ffffff";
}

function isNeoTouchPoint(device, context, coordinates) {
    if (device?.type !== 9) return false;
    // OpenDeck appends the two Neo sensors after the eight LCD keys.
    const slot = /\.Keypad\.(\d+)\.\d+$/.exec(context);
    if (slot) return slot[1] === "8" || slot[1] === "9";
    return coordinates?.row === 2 && (coordinates.column === 0 || coordinates.column === 1);
}

if (typeof module === "object") module.exports = { arrowColor, isNeoTouchPoint };
