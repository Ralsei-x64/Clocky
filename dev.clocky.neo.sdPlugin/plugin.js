"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
    faceFor, quotaFor, returnSecondsFor, clockLayer, mediaLabels, mediaCover,
    marqueeDelay, mediaScreen, mediaSprites, mediaTimeline, mediaTickDelay, quotaScreen, frame,
} = require("./faces");
const { createUsageSource } = require("./sources/usage");
const { createMediaSource } = require("./sources/media");
const { createStatsSource, statsInterval } = require("./sources/stats");
const { statsScreen } = require("./stats-screen");
const { arrowColor, isNeoTouchPoint } = require("./arrows");
const { ClockBackground, backgroundForFace, tintForFace } = require("./backgrounds");
const { pageLayout, defaultPageFor } = require("./pages");

const CLOCK = "dev.clocky.neo.clockface";
const NEXT = "dev.clocky.neo.next", PREVIOUS = "dev.clocky.neo.previous";
const swipeDuration = 360;
const pinHoldMs = 3000;
const noticeSlideMs = 300;
const noticeHoldMs = 2000;
const mediaVisitMs = 2000;
const pinnedArrowColor = "#808080";
const compactScale = .82;
function swipeEase(time) {
    const t = Math.max(0, Math.min(1, time));
    return (1 - (1 + 7 * t) * Math.exp(-7 * t)) / (1 - 8 * Math.exp(-7));
}
const arrowTemplates = new Map([PREVIOUS, NEXT].map((action) => {
    const name = action === NEXT ? "next" : "previous";
    return [action, fs.readFileSync(path.join(__dirname, "assets", name + ".svg"), "utf8")];
}));
const assetCache = new Map();
function asset(name) {
    if (!assetCache.has(name)) {
        const bytes = fs.readFileSync(path.join(__dirname, "assets", name + ".png"));
        assetCache.set(name, "data:image/png;base64," + bytes.toString("base64"));
    }
    return assetCache.get(name);
}

class Infobar {
    constructor(settings, publish, media, usage, stats = createStatsSource(), onPinChange) {
        this.settings = settings;
        this.clock = {};
        this.frameInterval = 1000 / 30;
        this.background = new ClockBackground(backgroundForFace(settings?.backgrounds, faceFor(settings)));
        this.tint = tintForFace(settings?.wallpaperTints, faceFor(settings));
        this.publish = publish;
        this.readMedia = media;
        this.readUsage = usage;
        this.readStats = stats;
        this.pages = [];
        this.queue = [];
        this.presses = new Map();
        this.pinned = false;
        this.onPinChange = onPinChange;
        this.pending = new Set();
        this.readAfter = {};
        this.values = {};
        this.closed = false;
        this.lastPaintAt = -Infinity;
        this.returnAt = null;
        this.labels = mediaLabels();
        this.marqueeStarted = performance.now();
        this.configurePages(settings);
    }

    configurePages(settings) {
        const pages = pageLayout(settings).filter((row) => row.enabled).map((row) => row.id);
        if (settings?.showNowPlaying === true && pages.includes("media") && pages.length > 1) {
            this.stopMediaMonitor ??= this.readMedia.monitorPlayback?.();
        } else {
            this.stopMediaMonitor?.();
            this.stopMediaMonitor = null;
            if (this.mediaVisit) {
                if ((this.slide?.to ?? this.page) === "media") this.mediaVisit.until = 0;
                else this.mediaVisit = null;
            }
        }
        const defaultPage = defaultPageFor(settings?.defaultPage, pages);
        if (defaultPage !== this.defaultPage) this.returnAt = null;
        this.defaultPage = defaultPage;
        if (pages.join() === this.pages.join()) return;
        // Track the visible screen by ID while the user edits its position.
        this.pages = pages;
        this.queue.length = 0;
        this.slide = null;
        this.returnAt = null;
        if (this.mediaVisit) {
            if (!pages.includes("media") || this.page !== "media") this.mediaVisit = null;
            else if (!pages.includes(this.mediaVisit.from)) {
                if (defaultPage === "media") this.mediaVisit = null;
                else this.mediaVisit.from = defaultPage;
            }
        }
        if (!pages.includes(this.page)) {
            this.clearPresses();
            this.setPinned(false);
            this.page = defaultPage;
        }
        if (pages.includes("media")) {
            this.unsubscribeMedia ??= this.readMedia.subscribe?.((track, initial) => {
                const visit = this.setMedia(track, initial);
                if (!this.closed && this.timer && (visit || this.page === "media" || this.slide?.to === "media")) {
                    this.requestDraw();
                }
            });
        } else {
            this.unsubscribeMedia?.();
            this.unsubscribeMedia = null;
            this.setMedia(undefined);
            delete this.readAfter.media;
        }
    }

    setMedia(value, initial = false) {
        const previous = this.values.media;
        if (!value) this.cover = undefined;
        if (value?.title !== this.values.media?.title || value?.artist !== this.values.media?.artist) {
            this.labels = mediaLabels(value);
            this.marqueeStarted = performance.now();
        }
        this.values.media = value;
        if (!value?.playing || !value.title || initial || this.closed || !this.pages.includes("media") || this.settings?.showNowPlaying !== true ||
            this.pinned || this.presses.size || this.queue.length) return false;
        const changed = !previous?.playing || previous.title !== value.title ||
            (previous.artist && value.artist && previous.artist !== value.artist) ||
            (previous.trackId && value.trackId && previous.trackId !== value.trackId);
        if (!changed) return false;
        const from = this.slide?.to ?? this.page;
        if (this.mediaVisit) this.mediaVisit.until = null;
        else if (from && from !== "media") this.mediaVisit = { from, until: null };
        else return false;
        this.returnAt = null;
        return true;
    }

    mediaVisitDelay(delay, sampledAt, accepted) {
        if (!this.mediaVisit || this.slide) return delay;
        if (this.page !== "media") return 0;
        if (accepted) this.mediaVisit.until ??= sampledAt + mediaVisitMs;
        return Math.min(delay, this.mediaVisit.until === null ? 20 : Math.max(0, this.mediaVisit.until - sampledAt));
    }

    setPinned(pinned) {
        if (pinned === this.pinned) return;
        this.pinned = pinned;
        this.pinNotice = pinned ? {} : null;
        this.returnAt = null;
        this.onPinChange?.();
    }

    pinPage() {
        this.queue.length = 0;
        this.mediaVisit = null;
        if (this.pinned) return;
        this.setPinned(true);
        this.requestDraw();
    }

    keyDown(context) {
        if (!this.page || this.presses.has(context)) return;
        this.mediaVisit = null;
        // A short return interval must not expire while the user is holding a key.
        this.returnAt = null;
        const press = { start: performance.now(), long: false };
        press.timer = setTimeout(() => {
            press.long = true;
            this.pinPage();
        }, pinHoldMs);
        this.presses.set(context, press);
    }

    keyUp(context, direction) {
        const press = this.presses.get(context);
        if (!press) return;
        clearTimeout(press.timer);
        this.presses.delete(context);
        if (press.long) return;
        if (performance.now() - press.start >= pinHoldMs) {
            // A delayed timer and the release can become runnable on the same turn.
            this.pinPage();
        } else this.move(direction);
    }

    cancelPress(context) {
        const press = this.presses.get(context);
        if (!press) return;
        clearTimeout(press.timer);
        this.presses.delete(context);
        this.requestDraw();
    }

    clearPresses() {
        for (const press of this.presses.values()) clearTimeout(press.timer);
        this.presses.clear();
    }

    move(direction) {
        this.clearPresses();
        this.mediaVisit = null;
        this.setPinned(false);
        this.returnAt = null;
        if (this.pages.length >= 2) this.queue.push(direction);
        this.requestDraw();
    }

    setNative(publish) {
        if (!!this.native === !!publish && this.timer) return;
        this.native = publish;
        this.nativePage = null;
        this.sent = null;
        this.draw();
    }

    paintNative(page, now, sampledAt, direction = 0, overlayFrame) {
        const fresh = this.nativePage !== page || direction !== 0;
        const patch = { page };
        if (fresh) patch.direction = direction;
        let base, rows = null, timeline = "";
        const track = this.values.media;
        if (overlayFrame !== undefined) {
            base = overlayFrame;
        } else if (page === "media" && track) {
            const art = track.artwork || asset("album-placeholder");
            if (this.cover?.image !== art) this.cover = { image: art, art: mediaCover(art) };
            base = this.cover.art;
            rows = this.labels;
            timeline = mediaTimeline(track, now);
        } else {
            const layer = page ? this.layer(page, now, sampledAt) : {};
            base = (layer.backdrop || "") + (layer.art || "");
        }
        if (fresh || base !== this.nativeBase) patch.base = base;
        if (fresh || rows !== this.nativeRows) patch.rows = rows ? mediaSprites(rows) : [];
        if (fresh || timeline !== this.nativeTimeline) patch.timeline = timeline;
        if (Object.keys(patch).length === 1) return true;
        if (!this.native(patch)) return false;
        this.nativePage = page;
        this.nativeBase = base;
        this.nativeRows = rows;
        this.nativeTimeline = timeline;
        return true;
    }

    drawPinNotice(now, sampledAt) {
        const notice = this.pinNotice;
        notice.start ??= sampledAt;
        const elapsed = sampledAt - notice.start;
        const leaving = notice.leaveAt !== undefined && sampledAt >= notice.leaveAt;
        if (leaving && sampledAt >= notice.leaveAt + noticeSlideMs) {
            this.pinNotice = null;
            return false;
        }
        const atRest = elapsed >= noticeSlideMs && !leaving;
        const progress = leaving ? (sampledAt - notice.leaveAt) / noticeSlideMs : Math.min(1, elapsed / noticeSlideMs);
        const ease = progress * progress * (3 - 2 * progress);
        const y = Number((50 * (leaving ? ease : 1 - ease)).toFixed(3));
        const artwork = `<image y="${y}" width="232" height="50" xlink:href="${asset("page-pinned")}"/>`;
        let art = artwork;
        if (!atRest) {
            // Take one snapshot per direction. On exit this includes changes made during the hold.
            if (!notice.underlay || leaving !== notice.leaving) {
                const layer = this.layer(this.page, now, sampledAt);
                notice.underlay = (layer.backdrop || "") + layer.art;
                notice.leaving = leaving;
            }
            art = notice.underlay + artwork;
            if (y < 50) {
                art = '<defs><clipPath id="pin-card"><rect width="232" height="50" rx="10"/></clipPath></defs>' +
                    `<g clip-path="url(#pin-card)">${art}</g>`;
            }
        }
        let sent;
        if (this.native) {
            sent = this.paintNative(this.page, now, sampledAt, 0, art);
        } else {
            const svg = frame([{ art }]);
            sent = svg === this.sent || this.publish(svg, !atRest);
            if (sent) {
                this.sent = svg;
                this.lastPaintAt = sampledAt;
                this.lastPaintWasSwipe = !atRest;
            }
        }
        // Start the two fully visible seconds once the centered frame is accepted.
        if (atRest && sent) notice.leaveAt ??= sampledAt + noticeHoldMs;
        const origin = leaving ? notice.leaveAt : notice.start;
        const next = origin + Math.min(noticeSlideMs,
            (Math.floor((sampledAt - origin) / this.frameInterval) + 1) * this.frameInterval);
        const deadline = atRest ? notice.leaveAt ?? sampledAt + this.frameInterval : next;
        this.timer = setTimeout(() => this.draw(), Math.max(1, Math.ceil(deadline - performance.now())));
        return true;
    }

    setFrameRate(fps) {
        const interval = 1000 / (fps === 60 ? 60 : 30);
        if (interval === this.frameInterval) return;
        this.frameInterval = interval;
        if (this.timer) this.draw();
    }

    update(settings) {
        if (returnSecondsFor(settings) !== returnSecondsFor(this.settings)) this.returnAt = null;
        this.background = this.background.withSettings(backgroundForFace(settings?.backgrounds, faceFor(settings)));
        this.tint = tintForFace(settings?.wallpaperTints, faceFor(settings));
        this.settings = settings;
        this.configurePages(settings);
        this.requestDraw();
    }

    poll(page) {
        if (!page || page === "clock") return;
        const key = page === "usage" ? quotaFor(this.settings) : page;
        if (this.pending.has(key) || Date.now() < (this.readAfter[key] || 0)) return;
        this.pending.add(key);
        const read = page === "stats" ? this.readStats() : page === "media" ? this.readMedia() : this.readUsage(key);
        Promise.resolve(read).catch(() => null).then((value) => {
            this.pending.delete(key);
            if (this.closed) return;
            if (key === "media") {
                if (!this.pages.includes("media")) return;
                if (!this.unsubscribeMedia) this.setMedia(value);
            } else this.values[key] = value;
            const interval = page === "stats" ? statsInterval : key === "media" ? 1000 : key === "context" ? 10000 : 60000;
            this.readAfter[key] = Date.now() + interval;
            if (key === "media" && this.unsubscribeMedia) return;
            if ((this.slide?.to ?? this.page) === page) this.requestDraw();
        });
    }

    requestDraw() {
        // The scheduled swipe frame picks up new artwork, settings and queued presses together.
        if (!this.slide || this.native) this.draw();
    }

    layer(page, now, sampledAt) {
        if (page === "stats") {
            const value = this.values.stats;
            if (!this.statsLayer || this.statsLayer.value !== value) {
                this.statsLayer = { value, art: statsScreen(value) };
            }
            return this.statsLayer;
        }
        if (page === "usage") {
            const mode = quotaFor(this.settings), value = this.values[mode];
            if (this.quota?.mode !== mode || this.quota.value !== value) {
                this.quota = { mode, value, art: quotaScreen(mode, value, asset) };
            }
            return this.quota;
        }
        if (page === "media") {
            const track = this.values.media;
            const cover = track && (track.artwork || asset("album-placeholder"));
            if (cover && this.cover?.image !== cover) this.cover = { image: cover, art: mediaCover(cover) };
            return {
                art: mediaScreen(
                    track,
                    now,
                    asset,
                    this.labels,
                    sampledAt - this.marqueeStarted,
                    this.cover?.art,
                ),
            };
        }
        return clockLayer(faceFor(this.settings), now, asset, this.background.at(sampledAt).image, this.clock, this.tint);
    }

    draw() {
        if (this.closed) return;
        clearTimeout(this.timer);
        this.timer = null;
        const frameInterval = this.frameInterval;
        const sampledAt = performance.now();
        const now = new Date();
        if (!this.page) {
            if (this.native) {
                if (!this.paintNative("", now, sampledAt)) this.timer = setTimeout(() => this.draw(), 40);
                return;
            }
            const blank = frame([]);
            if (this.sent !== blank) {
                if (this.publish(blank)) this.sent = blank;
                else this.timer = setTimeout(() => this.draw(), 40);
            }
            return;
        }
        const index = this.pages.indexOf(this.page);
        const adjacent = (dir) => this.pages[(index + dir + this.pages.length) % this.pages.length];
        const returning = this.returnAt !== null && now.getTime() >= this.returnAt;
        let target = returning ? this.defaultPage : null;
        if (this.mediaVisit && !this.slide) {
            if (this.page !== "media") target = "media";
            else if (this.mediaVisit.until !== null && sampledAt >= this.mediaVisit.until) target = this.mediaVisit.from;
        }
        if (!this.slide && (target || this.queue.length)) {
            let direction = target ? (adjacent(-1) === target ? -1 : 1) : this.queue.shift();
            if (this.mediaVisit && target === "media") this.mediaVisit.direction = direction;
            else if (this.mediaVisit && target === this.mediaVisit.from) {
                direction = -this.mediaVisit.direction;
                this.mediaVisit = null;
            }
            this.returnAt = null;
            this.slide = {
                direction,
                to: target ?? adjacent(direction),
                start: sampledAt,
            };
            if (this.slide.to === "media") {
                this.marqueeStarted = this.slide.start;
                this.readMedia.refresh?.();
            }
            if (this.slide.to === "stats" && Date.now() >= (this.readAfter.stats || 0)) delete this.values.stats;
        }
        const slide = this.slide;
        this.poll(slide ? slide.to : this.page);
        let layers, delay;
        if (slide) {
            const t = Math.min(1, (sampledAt - slide.start) / swipeDuration);
            if (t < 1 && this.native) {
                const sent = this.paintNative(slide.to, now, sampledAt, slide.submitted ? 0 : slide.direction);
                if (sent && !slide.submitted && this.mediaVisit && slide.to === "media") slide.start = sampledAt;
                slide.submitted ||= sent;
                const untilSettled = swipeDuration - (sampledAt - slide.start);
                const gif = slide.to === "clock" ? this.background.at(sampledAt, frameInterval).delay : Infinity;
                this.timer = setTimeout(() => this.draw(), Math.max(1, Math.ceil(Math.min(untilSettled, gif, sent ? Infinity : 20))));
                return;
            }
            if (t < 1) {
                const progress = swipeEase(t);
                const stride = 236;
                const x = -slide.direction * stride * progress;
                // Reach the compact pose while the outgoing page is still readable.
                // Hold the entering content at that size until most of it is visible.
                const outgoingScale = 1 - (1 - compactScale) * swipeEase(t / .24);
                const incomingScale = compactScale + (1 - compactScale) * swipeEase((t - .45) / .55);
                // Cards scale about x=116 within a 232 px viewport. Keep a pixel for antialiasing.
                layers = [
                    { page: this.page, x, scale: outgoingScale },
                    { page: slide.to, x: x + slide.direction * stride, scale: incomingScale },
                ].filter((card) => Math.abs(card.x) < 116 * (1 + card.scale) + 1)
                    .map((card) => ({ ...this.layer(card.page, now, sampledAt), x: card.x, scale: card.scale }));
            } else {
                this.page = slide.to;
                this.slide = null;
                if (this.page === "media") this.marqueeStarted = sampledAt;
            }
        }
        if (!this.slide && this.pinNotice && this.drawPinNotice(now, sampledAt)) return;
        if (!layers) {
            if (!this.native) layers = [this.layer(this.page, now, sampledAt)];
            const page = this.page;
            delay = this.queue.length
                ? 0
                : page === "media"
                ? mediaTickDelay(this.values.media, now)
                : page === "clock"
                ? 60000 - now.getTime() % 60000
                : Math.max(1000, (this.readAfter[page === "stats" ? page : quotaFor(this.settings)] || 0) - Date.now());
            const seconds = returnSecondsFor(this.settings);
            if (page === "clock") delay = Math.min(delay, this.background.at(sampledAt, frameInterval).delay);
            if (!this.native && page === "media" && this.labels.scrolls) {
                const track = this.values.media;
                const movingMeter = track?.playing && Number.isFinite(track.position) && track.duration > 0;
                const age = sampledAt - this.marqueeStarted;
                const nextTick = frameInterval - age % frameInterval;
                const next = movingMeter ? nextTick : marqueeDelay(this.labels, age, nextTick);
                delay = Math.min(delay, next);
            }
            if (!this.pinned && !this.mediaVisit && !this.presses.size && page !== this.defaultPage && !this.queue.length && seconds > 0) {
                this.returnAt ??= now.getTime() + seconds * 1000;
                delay = Math.min(delay, Math.max(0, this.returnAt - now.getTime()));
            }
        }
        if (this.native) {
            const accepted = this.paintNative(this.page, now, sampledAt);
            if (!accepted) delay = Math.min(delay, 20);
            delay = this.mediaVisitDelay(delay, sampledAt, accepted);
            this.timer = setTimeout(() => this.draw(), Math.max(1, Math.ceil(delay)));
            return;
        }
        const svg = frame(layers, !!this.slide);
        if (svg !== this.sent) {
            // Avoid back-to-back paints when a swipe starts, settles, or wakes late.
            const swipePaint = !!slide || this.lastPaintWasSwipe;
            const earliest = swipePaint ? this.lastPaintAt + frameInterval / 2 : 0;
            const paintAt = performance.now();
            if (paintAt < earliest) {
                if (!this.slide) delay = Math.min(delay, earliest - paintAt);
            } else if (this.publish(svg, swipePaint)) {
                this.sent = svg;
                this.lastPaintAt = paintAt;
                this.lastPaintWasSwipe = !!slide;
            } else if (!this.slide) delay = 40;
        }
        if (this.slide) {
            // Anchor the cadence to swipe start. Skip missed slots instead of replaying them.
            const end = performance.now();
            const slot = Math.floor((end - slide.start) / frameInterval) + 1;
            delay = Math.max(1, slide.start + Math.min(swipeDuration, slot * frameInterval) - end);
        }
        delay = this.mediaVisitDelay(delay, sampledAt, svg === this.sent);
        this.timer = setTimeout(() => this.draw(), Math.max(0, Math.ceil(delay)));
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.timer);
        this.clearPresses();
        this.setPinned(false);
        this.stopMediaMonitor?.();
        this.unsubscribeMedia?.();
    }
}

function startSession(
    socket,
    uuid,
    event,
    media = createMediaSource(),
    usage = createUsageSource(),
    devices = [],
    stats = createStatsSource(),
) {
    let animationFps = 30;
    const active = new Map();
    const buttons = new Map();
    const deviceInfo = new Map(devices.map((item) => [item.id, item]));
    function sendImage(context, svg) {
        if (socket.readyState !== 1) return false;
        const image = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
        socket.send(JSON.stringify({ event: "setImage", context, payload: { image, target: 0 } }));
        return true;
    }
    function controls(buttonId, buttonDevice, displayId, displayDevice) {
        if (buttonDevice !== displayDevice) return false;
        const index = buttonId.lastIndexOf(".Keypad.");
        return index < 0 || displayId.startsWith(buttonId.slice(0, index) + ".Infobar.");
    }
    function paintButton(context, button) {
        let color = arrowColor(button.settings);
        for (const [id, { device, display }] of active) {
            if (display.pinned && controls(context, button.device, id, device)) {
                color = pinnedArrowColor;
                break;
            }
        }
        const touch = isNeoTouchPoint(deviceInfo.get(button.device), context, button.coordinates);
        // OpenDeck drives a Neo touch point with the mean RGB of its complete rendered image.
        const svg = touch
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${color}"/></svg>`
            : arrowTemplates.get(button.action).replace('stroke="white"', `stroke="${color}"`);
        sendImage(context, svg);
    }
    function remove(context) {
        active.get(context)?.display.close();
        active.delete(context);
    }
    socket.onopen = () => socket.send(JSON.stringify({ event, uuid, subscribeFrameRate: true }));
    socket.onmessage = (message) => {
        const messageData = JSON.parse(message.data);
        const { event, action, device, context, payload } = messageData;
        if (event === "sonicFrameRateDidChange") {
            animationFps = payload?.fps === 60 ? 60 : 30;
            for (const { display } of active.values()) display.setFrameRate(animationFps);
        } else if (event === "sonicInfobarMode") {
            const display = active.get(context)?.display;
            display?.setNative(payload?.enabled ? (patch) => {
                if (socket.readyState !== 1 || socket.bufferedAmount > 192 * 1024) return false;
                socket.send(JSON.stringify({ event: "sonicInfobarScene", context, payload: patch }));
                return true;
            } : null);
        } else if (event === "systemDidWakeUp") {
            media.refresh?.();
            for (const { display } of active.values()) {
                display.clearPresses();
                display.readAfter = {};
                display.sent = null;
                display.nativePage = null;
                display.requestDraw();
            }
            for (const [id, button] of buttons) paintButton(id, button);
        } else if (event === "deviceDidConnect") {
            deviceInfo.set(device, messageData.deviceInfo);
            for (const [id, button] of buttons) if (button.device === device) paintButton(id, button);
        } else if (event === "deviceDidDisconnect") {
            for (const [id, button] of buttons) if (button.device === device) buttons.delete(id);
            for (const [id, entry] of active) if (entry.device === device) remove(id);
            deviceInfo.delete(device);
        } else if (action === CLOCK) {
            if (event === "willAppear") {
                remove(context);
                const publish = (svg, swiping) => {
                    const bufferLimit = swiping ? 0 : 192 * 1024;
                    return socket.bufferedAmount <= bufferLimit && sendImage(context, svg);
                };
                const display = new Infobar(payload?.settings, publish, media, usage, stats, () => {
                    for (const [id, button] of buttons) {
                        if (controls(id, button.device, context, device)) paintButton(id, button);
                    }
                });
                display.setFrameRate(animationFps);
                active.set(context, { display, device });
                if (messageData.sonicInfobar) socket.send(JSON.stringify({ event: "sonicRequestInfobar", context }));
                else display.draw();
            } else if (event === "willDisappear") remove(context);
            else if (event === "didReceiveSettings") active.get(context)?.display.update(payload?.settings);
        } else if (action === NEXT || action === PREVIOUS) {
            if (event === "willAppear") {
                const button = {
                    device,
                    action,
                    settings: payload?.settings,
                    coordinates: payload?.coordinates,
                };
                buttons.set(context, button);
                paintButton(context, button);
            } else if (event === "didReceiveSettings" && buttons.has(context)) {
                const button = buttons.get(context);
                button.settings = payload?.settings;
                paintButton(context, button);
            } else if (event === "willDisappear") buttons.delete(context);
            if (event !== "keyDown" && event !== "keyUp" && event !== "willDisappear") return;
            for (const [id, entry] of active) {
                if (!controls(context, device, id, entry.device)) continue;
                if (event === "keyDown") entry.display.keyDown(context);
                else if (event === "keyUp") entry.display.keyUp(context, action === NEXT ? 1 : -1);
                else entry.display.cancelPress(context);
            }
        }
    };
    socket.onclose = () => {
        for (const id of active.keys()) remove(id);
        buttons.clear();
    };
}

if (require.main === module) {
    // GUI-launched OpenDeck may inherit a shorter PATH than a login shell.
    if (process.platform === "darwin") process.env.PATH += ":/opt/homebrew/bin:/usr/local/bin";
    const args = process.argv.slice(2);
    const option = (key) => args[args.indexOf(key) + 1];
    const port = Number(option("-port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Start Clocky from OpenDeck.");
    const devices = args.includes("-info") ? JSON.parse(option("-info")).devices : [];
    startSession(
        new WebSocket("ws://127.0.0.1:" + port),
        option("-pluginUUID"),
        option("-registerEvent"),
        undefined,
        undefined,
        devices,
    );
}
module.exports = { startSession, Infobar, asset };
