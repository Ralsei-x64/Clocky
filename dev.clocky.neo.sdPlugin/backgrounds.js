"use strict";

// Settings hold only the Infobar-sized frames, so a profile can travel with its backgrounds.
function backgroundForFace(backgrounds, face) {
    return backgrounds?.[face] ?? backgrounds?.default;
}

function tintForFace(tints, face) {
    const tint = tints?.[face];
    return {
        color: typeof tint?.color === "string" && /^#[\da-f]{6}$/i.test(tint.color) ? tint.color : "#000000",
        strength: Number.isFinite(tint?.strength) ? Math.min(100, Math.max(0, Math.round(tint.strength))) : 0,
    };
}

class ClockBackground {
    constructor(value, start = performance.now()) {
        this.start = start;
        this.frames = [];
        this.ends = [];
        this.duration = 0;
        this.plays = Number.isSafeInteger(value?.plays) && value.plays > 0 ? value.plays : 0;
        if (!Array.isArray(value?.frames)) return;
        for (const frame of value.frames) {
            if (typeof frame?.image !== "string" || !frame.image.startsWith("data:image/jpeg;base64,")) {
                continue;
            }
            this.duration += Number.isFinite(frame.ms) && frame.ms > 0 ? frame.ms : 100;
            this.frames.push(frame.image);
            this.ends.push(this.duration);
        }
    }

    withSettings(value) {
        const next = new ClockBackground(value);
        // OpenDeck echoes the whole profile, including the GIF, after a tint edit.
        if (this.frames.length > 1 && this.plays === next.plays && this.frames.length === next.frames.length &&
            this.frames.every((image, i) => image === next.frames[i] && this.ends[i] === next.ends[i])) return this;
        return next;
    }

    at(now = performance.now(), frameInterval = 1000 / 30) {
        const elapsed = Math.max(0, now - this.start);
        if (this.frames.length < 2 || (this.plays && elapsed >= this.plays * this.duration)) {
            return { image: this.frames.at(-1), delay: Infinity };
        }
        const phase = elapsed % this.duration;
        let lo = 0, hi = this.ends.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (phase < this.ends[mid]) hi = mid;
            else lo = mid + 1;
        }
        return { image: this.frames[lo], delay: Math.max(frameInterval, this.ends[lo] - phase) };
    }
}

if (typeof module === "object") module.exports = { ClockBackground, backgroundForFace, tintForFace };
