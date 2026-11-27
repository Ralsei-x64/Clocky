const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const plugin = path.resolve(__dirname, "../dev.clocky.neo.sdPlugin");
const { startSession, Infobar } = require(path.join(plugin, "plugin"));
const { windowFor, remaining, contextRemaining, latestUsage } = require(path.join(plugin, "sources/usage"));
const { mediaLabels, mediaScreen, quotaScreen, returnSecondsFor } = require(path.join(plugin, "faces"));
const { createMediaSource, systemTrack } = require(path.join(plugin, "sources/media"));
const { ClockBackground, tintForFace } = require(path.join(plugin, "backgrounds"));
const { statsScreen } = require(path.join(plugin, "stats-screen"));
const { pageLayout } = require(path.join(plugin, "pages"));
const { createStatsSource, linuxStats } = require(path.join(plugin, "sources/stats"));
const { faces, faceFor, clockScreen, clockLayer, marqueeDelay } = require(path.join(plugin, "faces"));

test("all faces accept a background below their live time and restore their original artwork", () => {
    const image = "data:image/jpeg;base64,YQ==";
    const date = new Date(2026, 10, 4, 10, 1);
    assert.equal(faceFor({ face: "normal" }), "normal");
    assert.equal(faceFor({}), "normal");
    assert.equal(faceFor({ face: "missing" }), "normal");
    assert.equal(faceFor({ face: "almanac" }), "almanac");
    for (const name of ["dots", "dots-dark", "flux-a", "flux-a-dark", "flux-b", "flux-b-dark",
        "flux-c", "flux-c-dark", "flux-d", "flux-d-dark"]) {
        assert.equal(faceFor({ face: name }), name);
        const before = clockScreen(name, date);
        assert.notEqual(clockScreen(name, new Date(2026, 10, 4, 10, 2)), before);
        assert.equal(clockScreen(name, new Date(2026, 10, 5, 10, 1)) !== before, name.startsWith("dots"));
    }
    for (const face of Object.keys(faces)) {
        const original = clockScreen(face, date, (name) => name + ".png");
        const custom = clockScreen(face, date, (name) => name + ".png", image);
        assert.ok(custom.indexOf(image) >= 0);
        assert.match(custom, /clip-path="url\(#clock-background\)"/);
        assert.doesNotMatch(original, /clock-background/);
        if (face === "clouds") assert.doesNotMatch(custom, /clouds\.png/);
        if (face === "normal") {
            assert.match(custom, />10:01<\/text>/);
            assert.match(custom, />Nov 4<\/text>/);
        }
    }
});

test("each face tints only its wallpaper, including a shared GIF, and preserves its playback on tint edits", () => {
    const frames = ["YQ==", "Yg=="].map((s) => ({ image: "data:image/jpeg;base64," + s, ms: 100 }));
    const gif = { frames, plays: 1 };
    const tints = { dots: { color: "#123456", strength: 60 }, "flux-a": { color: "#abcdef", strength: 80 } };
    const display = new Infobar({ face: "dots", backgrounds: { default: gif }, wallpaperTints: tints },
        () => true, async () => null, async () => null);
    try {
        const date = new Date(2026, 10, 4, 10, 1), start = display.background.start;
        const { art, backdrop } = display.layer("clock", date, start + 125);
        assert.match(backdrop, /fill="#123456" opacity="0.6"/);
        assert.ok(backdrop.includes(frames[1].image));
        display.update({ face: "dots", backgrounds: { default: structuredClone(gif) },
            wallpaperTints: { ...tints, dots: { ...tints.dots, strength: 25 } } });
        assert.equal(display.background.start, start);
        assert.equal(display.layer("clock", date, start + 125).art, art);
        assert.match(display.layer("clock", date, start + 125).backdrop, /fill="#123456" opacity="0.25"/);
        display.update({ face: "flux-a", backgrounds: { default: gif }, wallpaperTints: tints });
        assert.match(display.layer("clock", date, start).backdrop, /fill="#abcdef" opacity="0.8"/);
        display.update({ face: "flux-b", backgrounds: { default: gif }, wallpaperTints: tints });
        assert.doesNotMatch(display.layer("clock", date, start).backdrop, /opacity=/);
        display.update({ face: "dots", wallpaperTints: tints });
        assert.doesNotMatch(display.layer("clock", date, start).backdrop, /#123456/);
        assert.deepEqual(tintForFace({ dots: { color: "invalid", strength: -10 } }, "dots"),
            { color: "#000000", strength: 0 });
    } finally {
        display.close();
    }
});

test("cached clock layers follow the minute, face and current GIF image independently", () => {
    const asset = (name) => name + ".png";
    const cache = {};
    const before = new Date(2026, 10, 4, 23, 59);
    const after = new Date(2026, 10, 5, 0, 0);
    const first = "data:image/jpeg;base64,YQ==";
    const second = "data:image/jpeg;base64,Yg==";
    for (const [face, time, image] of [
        ["normal", before, first], ["normal", before, second], ["normal", after, second],
        ["clouds", after, second], ["clouds", after, undefined], ["mint", after, undefined],
    ]) {
        const { backdrop, art } = clockLayer(face, time, asset, image, cache);
        assert.equal(backdrop + art, clockScreen(face, time, asset, image));
        if (face === "clouds") {
            assert.equal((backdrop + art).split(image ?? "clouds.png").length - 1, 1);
            assert.match(art, /xlink:href="#cloud-texture"/);
        }
    }
});

test("GIF backgrounds honor unequal frame times, repeated cycles, and a finite last frame", () => {
    const red = "data:image/jpeg;base64,YQ==", blue = "data:image/jpeg;base64,Yg==";
    const frames = [{ image: red, ms: 120 }, { image: blue, ms: 360 }];
    const player = new ClockBackground({ frames, plays: 2 }, 100);
    for (
        const [time, expected, delay] of [[100, red, 120], [220, blue, 360], [580, red, 120], [
            1060,
            blue,
            Infinity,
        ]]
    ) {
        assert.deepEqual(player.at(time), { image: expected, delay });
    }
    assert.equal(new ClockBackground({ frames }, 0).at(480 * 50 + 119).image, red);
    assert.deepEqual(new ClockBackground().at(), { image: undefined, delay: Infinity });
});

test("opposite keypad actions slide, wrap, and stay on their device and profile", async () => {
    const sent = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (raw) => sent.push(JSON.parse(raw)) };
    const track = {
        title: "Track & Title",
        artist: "Artist",
        duration: 120,
        position: 12,
        playing: false,
        sampledAt: Date.now(),
    };
    startSession(
        socket,
        "clocky",
        "registerPlugin",
        async () => track,
        async (mode) => mode === "weekly" ? 25 : 80,
        [],
        async () => ({ cpu: 42, gpu: 10, ram: 80, battery: 65, charging: true }),
    );
    const emit = (event, action, device, context, settings) =>
        socket.onmessage({
            data: JSON.stringify({
                event,
                action: "dev.clocky.neo." + action,
                device,
                context,
                payload: { settings },
            }),
        });
    const bar = "d.one.Infobar.0.0";
    const key = (event, action, slot) => emit(event, action, "d", "d.one.Keypad." + slot + ".0");
    const tap = (action, slot) => {
        key("keyDown", action, slot);
        key("keyUp", action, slot);
    };
    const frames = () =>
        sent.filter((x) => x.context === bar).map((x) =>
            Buffer.from(x.payload.image.split(",")[1], "base64").toString()
        );
    try {
        socket.onopen();
        assert.equal(sent.shift().event, "registerPlugin");
        emit("willAppear", "clockface", "d", bar, { face: "mint", quota: "weekly" });
        emit("willAppear", "clockface", "other", "other.one.Infobar.0.0", {});
        emit("willAppear", "clockface", "d", "d.two.Infobar.0.0", {});
        assert.match(frames().at(-1), /#d2ffe9/);
        tap("next", 7);
        await delay(420);
        assert.match(frames().at(-1), /Track &amp; Title/);
        assert.ok(frames().some((x) => /translate\(-[1-9]\d*\.\d+ 0\)/.test(x)));
        tap("next", 3);
        await delay(420);
        assert.match(frames().at(-1), /Weekly Limit/);
        assert.match(frames().at(-1), /25%/);
        emit("didReceiveSettings", "clockface", "d", bar, { face: "mint", quota: "context" });
        await delay(1);
        assert.match(frames().at(-1), /Context Left/);
        tap("next", 7);
        await delay(420);
        assert.match(frames().at(-1), />42<\/text>/);
        assert.match(frames().at(-1), /#ff383c/);
        tap("next", 7);
        await delay(420);
        assert.match(frames().at(-1), /#d2ffe9/);
        tap("previous", 0);
        tap("previous", 0);
        tap("previous", 0);
        await delay(1220);
        assert.match(frames().at(-1), /Track &amp; Title/);
        assert.ok(frames().some((x) => /translate\([1-9]\d*\.\d+ 0\)/.test(x)));
        assert.equal(sent.filter((x) => x.context === "d.two.Infobar.0.0").length, 1);
        assert.equal(sent.filter((x) => x.context === "other.one.Infobar.0.0").length, 1);
        key("keyDown", "next", 0);
        emit("willDisappear", "clockface", "d", bar);
        const count = frames().length;
        await delay(100);
        assert.equal(frames().length, count);
    } finally {
        socket.onclose();
    }
});

test("usage windows, empty readings and Codex context calculations", () => {
    const weekly = { usedPercent: 64, windowDurationMins: 10080 };
    const short = { usedPercent: 18, windowDurationMins: 300 };
    assert.equal(remaining(windowFor({ primary: weekly }, "weekly")), 36);
    assert.equal(remaining(windowFor({ primary: short, secondary: weekly }, "current")), 82);
    assert.equal(windowFor({ primary: short }, "weekly"), null);
    assert.equal(remaining({ used_percent: 45, resets_at: 1 }), null);
    assert.equal(remaining({ usedPercent: 100 }), 0);
    assert.equal(
        contextRemaining({ model_context_window: 112000, last_token_usage: { total_tokens: 62000 } }),
        50,
    );
    assert.equal(contextRemaining(null), null);
    assert.match(quotaScreen("current", null, () => ""), /—/);
    assert.match(mediaScreen(null, new Date(), () => ""), /Nothing is playing/);
});

test("navigation colors follow each assignment and drive the Neo touch lights at full color", () => {
    const sent = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (raw) => sent.push(JSON.parse(raw)) };
    startSession(socket, "clocky", "registerPlugin", undefined, undefined, [{ id: "neo", type: 9 }, {
        id: "xl",
        type: 2,
    }]);
    function emit(event, device, slot, direction, color) {
        socket.onmessage({
            data: JSON.stringify({
                event,
                device,
                action: "dev.clocky.neo." + direction,
                context: device + ".p.Keypad." + slot + ".0",
                payload: { settings: { color } },
            }),
        });
        return Buffer.from(sent.at(-1).payload.image.split(",")[1], "base64").toString();
    }
    try {
        const previous = emit("willAppear", "neo", 3, "previous", "#128af2");
        assert.match(previous, /M37 24H14/);
        assert.match(previous, /stroke="#128af2"/);
        for (const [slot, direction, color] of [[8, "previous", "#ff0000"], [9, "next", "#00ff00"]]) {
            const solid = emit("willAppear", "neo", slot, direction, color);
            assert.ok(solid.includes('fill="' + color + '"'));
            assert.doesNotMatch(solid, /<path|rx=|black/);
        }
        assert.match(emit("didReceiveSettings", "neo", 9, "next", "#0066FF"), /fill="#0066ff"/);
        assert.match(emit("willAppear", "xl", 9, "next", "invalid"), /stroke="#ffffff"/);
        assert.match(emit("willAppear", "late", 8, "previous", "#88cc00"), /<path/);
        socket.onmessage({
            data: JSON.stringify({
                event: "deviceDidConnect",
                device: "late",
                deviceInfo: { id: "late", type: 9 },
            }),
        });
        assert.doesNotMatch(
            Buffer.from(sent.at(-1).payload.image.split(",")[1], "base64").toString(),
            /<path/,
        );
        const count = sent.length;
        emit("willDisappear", "neo", 9, "next");
        emit("didReceiveSettings", "neo", 9, "next", "#ffffff");
        assert.equal(sent.length, count);
    } finally {
        socket.onclose();
    }
});

test("Zen metadata with no timeline still shows the playing title; reported positions use the current sample", () => {
    const zen = systemTrack({
        bundleIdentifier: "app.zen-browser.zen",
        title: "A & B",
        playing: true,
        timestamp: "2025-01-01",
    });
    assert.equal(zen.position, null);
    const svg = mediaScreen({ ...zen, sampledAt: 0 }, new Date(10000), () => "");
    assert.match(svg, /A &amp; B/);
    assert.equal(svg.match(/--:--/g).length, 2);
    const positioned = systemTrack({
        title: "Track",
        elapsedTime: 3,
        elapsedTimeNow: 40,
        duration: 120,
        playing: true,
        playbackRate: 2,
    });
    assert.match(mediaScreen({ ...positioned, sampledAt: 1000 }, new Date(2000), () => ""), /00:42/);
});

test("overflowing titles and artists hold, scroll independently, and wrap to the first frame", () => {
    const track = { title: "W".repeat(30), artist: "i".repeat(30) };
    const rows = mediaLabels(track);
    assert.ok(rows.title.width > 170 && rows.artist.width < 170);
    const frameAt = (age) => mediaScreen(track, new Date(0), () => "", rows, age);
    assert.equal(frameAt(0), frameAt(1300));
    assert.match(frameAt(2400), /translate\(-23\.00 0\)/);
    assert.match(frameAt(2400), /<use xlink:href="#media-title"/);
    assert.doesNotMatch(frameAt(2400), /<use xlink:href="#media-artist"/);
    assert.equal(frameAt(0), frameAt(1400 + (rows.title.width + 24) * 1000 / 23 + 1));
    const artistOnly = { title: "Hi", artist: "星".repeat(20) };
    const artistFrame = mediaScreen(artistOnly, new Date(0), () => "", mediaLabels(artistOnly), 3000);
    assert.match(artistFrame, /<use xlink:href="#media-artist"/);
    assert.doesNotMatch(artistFrame, /<use xlink:href="#media-title"/);
    assert.equal(mediaLabels({ title: "é👨‍👩‍👧‍👧" }).title.width, mediaLabels({ title: "e\u0301🌍" }).title.width);
});

test("marquee rendering sleeps during a hold and wakes for either scrolling row", () => {
    const interval = 1000 / 30;
    const single = mediaLabels({ title: "W".repeat(32), artist: "A" });
    assert.equal(marqueeDelay(single, 0, interval), 1400);
    assert.equal(marqueeDelay(single, 1000, interval), 400);
    assert.equal(marqueeDelay(single, 1500, interval), interval);
    const both = mediaLabels({ title: "W".repeat(32), artist: "W".repeat(45) });
    const titleLoop = 1400 + (both.title.width + 24) * 1000 / 23;
    assert.ok(marqueeDelay(single, titleLoop + 1, interval) > 1300);
    assert.equal(marqueeDelay(both, titleLoop + 1, interval), interval);
});

test("marquees survive position updates and restart on changed metadata", async () => {
    let track = { title: "A long title ".repeat(5), artist: "A" };
    const bar = new Infobar({}, () => true, async () => track, async () => 0);
    try {
        bar.move(1);
        await delay(460);
        const started = bar.marqueeStarted;
        const deadline = bar.returnAt;
        track = { ...track, position: 17 };
        bar.readAfter.media = 0;
        bar.draw();
        await delay(10);
        assert.equal(bar.marqueeStarted, started);
        track = { title: "Next", artist: "B" };
        bar.readAfter.media = 0;
        bar.draw();
        await delay(10);
        assert.ok(bar.marqueeStarted > started);
        assert.equal(bar.labels.scrolls, false);
        assert.equal(bar.returnAt, deadline);
    } finally {
        bar.close();
    }
});

test("the idle timer arms after settling, survives data refresh, and returns with one swipe", async () => {
    assert.equal(returnSecondsFor({}), 30);
    const frames = [];
    const display = new Infobar(
        { returnSeconds: 1 },
        (svg) => {
            frames.push(svg);
            return true;
        },
        async () => null,
        async () => 72,
    );
    try {
        display.move(1);
        await delay(460);
        assert.equal(display.page, "media");
        const firstDeadline = display.returnAt;
        assert.ok(firstDeadline > Date.now());
        display.draw();
        assert.equal(display.returnAt, firstDeadline);
        display.move(1);
        assert.equal(display.returnAt, null);
        await delay(460);
        assert.equal(display.page, "usage");
        assert.ok(display.returnAt > firstDeadline);
        frames.length = 0;
        await delay(1450);
        assert.equal(display.page, "clock");
        assert.equal(display.returnAt, null);
        assert.ok(
            frames.some((svg) =>
                svg.includes('id="swipe-card"') && svg.includes("scale(") && svg.includes("Usage Limit")
            ),
        );
        assert.ok(!frames.at(-1).includes('id="swipe-card"'));
        display.move(1);
        await delay(460);
        display.update({ returnSeconds: 0 });
        assert.equal(display.returnAt, null);
        await delay(1050);
        assert.equal(display.page, "media");
    } finally {
        display.close();
    }
});

test("reads the last complete usage record across a long trailing tool event", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clocky-test-"));
    const file = path.join(temp, "session.jsonl");
    const usage = {
        type: "event_msg",
        payload: {
            type: "token_count",
            info: { model_context_window: 120000, last_token_usage: { total_tokens: 40000 } },
        },
    };
    try {
        await fs.writeFile(
            file,
            JSON.stringify(usage) + "\n" +
                JSON.stringify({ type: "response_item", data: "x".repeat(500000) }) + "\n" +
                '{"type":"event_msg"',
        );
        const fd = await fs.open(file, "r");
        try {
            assert.deepEqual((await latestUsage(fd)).info, usage.payload.info);
        } finally {
            await fd.close();
        }
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
});

test("the first enabled page is the automatic default, including when Clock is off", async () => {
    const settings = (order, off = []) => ({
        pages: [...order.map((id) => ({ id, enabled: !off.includes(id) })), { id: "stats", enabled: false }],
        returnSeconds: 1,
    });
    const order = ["usage", "media", "clock"];
    const frames = [];
    let mediaReads = 0;
    const display = new Infobar(settings(order, ["clock"]), (svg) => {
        frames.push(svg);
        return true;
    }, async () => {
        mediaReads++;
        return null;
    }, async () => 20);
    try {
        display.draw();
        assert.equal(display.page, "usage");
        assert.equal(display.returnAt, null);
        display.move(-1);
        assert.equal(display.slide.to, "media");
        await delay(440);
        assert.equal(display.page, "media");
        assert.ok(display.returnAt > Date.now());
        assert.ok(mediaReads > 0);

        display.update(settings(["clock", "media", "usage"]));
        assert.equal(display.page, "media");
        assert.ok(display.returnAt > Date.now());
        display.move(1);
        display.move(1);
        display.update(settings(order, ["media", "usage"]));
        assert.equal(display.page, "clock");
        assert.equal(display.slide, null);
        assert.deepEqual(display.queue, []);
        display.move(1);
        assert.equal(display.slide, null);

        display.update(settings(order, order));
        assert.equal(display.page, undefined);
        assert.equal(display.returnAt, null);
        const count = frames.length;
        display.move(-1);
        assert.equal(frames.length, count);
        assert.doesNotMatch(frames.at(-1), /<text|<image|<path|swipe-card/);
        display.update(settings(order, ["clock"]));
        assert.equal(display.page, "usage");
        display.update(settings(["clock", "media", "usage"]));
        display.returnAt = Date.now() - 1;
        display.draw();
        assert.equal(display.slide.to, "clock");
        assert.equal(display.slide.direction, 1);
    } finally {
        display.close();
    }
});

test("a named default opens first and remains the timed destination after reordering", (t) => {
    let time = 0;
    t.mock.method(performance, "now", () => time);
    const settings = { defaultPage: "media", returnSeconds: 1 };
    const pages = ["usage", "clock", "media"].map((id) => ({ id, enabled: true }));
    pages.push({ id: "stats", enabled: false });
    const display = new Infobar(settings, () => true, async () => null, async () => 72);
    const settle = () => {
        time += 400;
        display.draw();
    };
    try {
        display.draw();
        assert.equal(display.page, "media");
        assert.equal(display.returnAt, null);
        display.update({ ...settings, pages });
        display.move(1);
        settle();
        assert.equal(display.page, "usage");
        assert.ok(display.returnAt > Date.now());
        display.returnAt = Date.now() - 1;
        time += 1000;
        display.draw();
        assert.equal(display.slide.to, "media");
        assert.match(display.sent, /id="swipe-card"/);
        settle();
        assert.equal(display.returnAt, null);

        display.update({ ...settings, pages, defaultPage: "usage" });
        assert.equal(display.page, "media");
        assert.ok(display.returnAt > Date.now());
        display.returnAt = Date.now() - 1;
        display.draw();
        assert.equal(display.slide.to, "usage");
        settle();
        assert.equal(display.page, "usage");
        assert.equal(display.returnAt, null);

        const mediaOff = pages.map((row) => ({ ...row, enabled: row.id !== "media" }));
        display.update({ ...settings, pages: mediaOff });
        assert.equal(display.defaultPage, "usage");
        assert.equal(display.returnAt, null);
        display.update({ ...settings, pages });
        assert.equal(display.defaultPage, "media");
        assert.ok(display.returnAt > Date.now());
        display.update({ ...settings, pages, returnSeconds: 0 });
        assert.equal(display.returnAt, null);
    } finally {
        display.close();
    }
});

test("wallpaper and content share the centered zoom in both swipe directions", (t) => {
    let time = 0;
    t.mock.method(performance, "now", () => time);
    const display = new Infobar({ face: "mint" }, () => true, async () => null, async () => 1);
    try {
        for (const direction of [-1, 1]) {
            time += 100;
            display.move(direction);
            function sample(elapsed) {
                time = display.slide.start + elapsed;
                display.draw();
                return [...display.sent.matchAll(/translate\(116 25\) scale\(([\d.]+)\)/g)].map((m) =>
                    Number(m[1])
                );
            }
            const start = sample(0), early = sample(35), mid = sample(100);
            assert.deepEqual(start, [1]);
            assert.ok(early[0] < .95 && early[0] > .82);
            assert.equal(early[1], .82);
            assert.deepEqual(mid, [.82, .82]);
            assert.match(
                display.sent,
                /translate\(-116 -25\)" clip-path="url\(#swipe-card\)"><rect[^>]+fill="#d2ffe9"\/><g fill="#2e604c">/,
            );
            const late = sample(230), end = sample(345);
            assert.ok(late.at(-1) > .82 && late.at(-1) < 1);
            assert.equal(end.length, 1);
            assert.ok(end[0] > .998 && end[0] <= 1);
            time = display.slide.start + 360;
            display.draw();
            assert.equal(display.slide, null);
        }
    } finally {
        display.close();
    }
});

test("a swipe coalesces media updates, skips congested frames and retries its settled page", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    t.mock.method(performance, "now", () => Date.now());
    const frames = [];
    let notify;
    const media = async () => null;
    media.subscribe = (listener) => {
        notify = listener;
        return () => {};
    };
    const socket = { readyState: 1, bufferedAmount: 0, send(raw) {
        const data = JSON.parse(raw);
        frames.push({ time: Date.now(), svg: Buffer.from(data.payload.image.split(",")[1], "base64").toString() });
    } };
    startSession(socket, "clocky", "registerPlugin", media, async () => 0);
    function emit(event, action, context) {
        socket.onmessage({ data: JSON.stringify({ event, action: "dev.clocky.neo." + action, device: "neo", context }) });
    }
    try {
        emit("willAppear", "clockface", "neo.p.Infobar.0.0");
        emit("keyDown", "next", "neo.p.Keypad.8.0");
        emit("keyUp", "next", "neo.p.Keypad.8.0");
        await Promise.resolve();
        for (let ms = 1; ms <= 445; ms++) {
            socket.bufferedAmount = (ms >= 80 && ms <= 180) || (ms >= 350 && ms <= 401) ? 8192 : 0;
            if (ms < 360) notify({ title: "Sample " + ms, artist: "Artist" });
            t.mock.timers.tick(1);
        }
        assert.deepEqual(frames.map(({ time }) => time), [0, 34, 67, 200, 234, 267, 300, 334, 440]);
        assert.match(frames[3].svg, />Sample 200</);
        assert.match(frames.at(-1).svg, />Sample 359</);
        assert.doesNotMatch(frames.at(-1).svg, /swipe-card/);
    } finally {
        socket.onclose();
    }
});

test("live cover updates beat the polling interval, reuse thumbnails, and reject stale art and reads", async () => {
    let push, stops = 0, resolvePoll;
    const loads = new Map(), seen = [];
    const source = createMediaSource({
        watch: (listener) => {
            push = listener;
            return () => {
                stops++;
            };
        },
        readTrack: () =>
            new Promise((resolve) => {
                resolvePoll = resolve;
            }),
        loadArtwork: (url) =>
            new Promise((resolve) => {
                assert.ok(!loads.has(url));
                loads.set(url, resolve);
            }),
    });
    const unsub = source.subscribe((value) => seen.push(value));
    const unsub2 = source.subscribe(() => {});
    const poll = source();
    push({ title: "Track A", art: "cover-A" });
    assert.equal(seen.at(-1).artwork, null);
    push({ title: "Track B", art: "cover-B" });
    loads.get("cover-A")("image-A");
    resolvePoll({ title: "Stale", art: "unused" });
    await poll;
    assert.equal(seen.at(-1).title, "Track B");
    assert.equal(seen.at(-1).artwork, null);
    loads.get("cover-B")("image-B");
    await delay(0);
    assert.equal(seen.at(-1).artwork, "image-B");
    push({ title: "Track A", art: "cover-A" });
    assert.equal(seen.at(-1).artwork, "image-A");
    assert.equal(loads.size, 2);
    unsub();
    assert.equal(stops, 0);
    unsub2();
    assert.equal(stops, 1);
});

test("a hidden media page warms the cover without waking the clock and releases its listener when disabled", (t) => {
    let time = 0;
    t.mock.method(performance, "now", () => time);
    let notify, stops = 0, newFrames = 0;
    const source = async () => null;
    source.subscribe = (fn) => {
        notify = fn;
        return () => {
            stops++;
        };
    };
    const display = new Infobar(
        {},
        () => {
            newFrames++;
            return true;
        },
        source,
        async () => 1,
    );
    try {
        display.draw();
        notify({ title: "Live", artwork: "data:image/png;base64,YQ==" });
        assert.equal(newFrames, 1);
        time += 100;
        display.move(1);
        time += 34; // First frame in which the incoming media card is visible.
        display.draw();
        assert.match(display.sent, /data:image\/png;base64,YQ==/);
        display.update({ pages: [{ id: "media", enabled: false }] });
        assert.equal(stops, 1);
        assert.equal(display.values.media, undefined);
    } finally {
        display.close();
    }
});

test("new pages join saved layouts and preserve an explicitly blank Infobar", () => {
    const saved = ["media", "usage", "clock"].map((id) => ({ id, enabled: true }));
    assert.deepEqual(pageLayout({ pages: saved }), [...saved, { id: "stats", enabled: true }]);
    assert.ok(pageLayout({ pages: saved.map((row) => ({ ...row, enabled: false })) }).every((row) => !row.enabled));
});

test("stats distinguish idle from missing hardware, show high load, and replace the battery number while charging", () => {
    const stats = { cpu: 0, gpu: null, ram: 80, battery: 99, charging: false };
    const svg = statsScreen(stats);
    assert.deepEqual([...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]), ["0", "—", "80", "99"]);
    assert.equal((svg.match(/opacity=".18"/g) || []).length, 4);
    assert.equal((svg.match(/stroke="#ff383c"/g) || []).length, 1);
    assert.doesNotMatch(svg, /stroke="#34c759"/);
    const charging = statsScreen({ ...stats, pluggedIn: true, charging: true });
    const bolt = require(path.join(plugin, "assets/stats-paths.json")).bolt;
    assert.ok(charging.includes(bolt) && !svg.includes(bolt));
    assert.doesNotMatch(charging, />99<\/text>/);
    assert.doesNotMatch(statsScreen({ ram: 79 }), /stroke="#ff383c"/);
});

test("battery gauge follows external power above 20% and uses the CPU warning red at or below 20%", () => {
    function batteryStroke(battery, pluggedIn, charging = false) {
        const art = statsScreen({ battery, pluggedIn, charging });
        return /<path stroke="(#[0-9a-f]+)" d="/.exec(art)?.[1];
    }
    for (const pluggedIn of [false, true]) {
        for (const percent of [0, 1, 19, 20]) {
            assert.equal(batteryStroke(percent, pluggedIn, pluggedIn), "#ff383c");
        }
        assert.equal(batteryStroke(null, pluggedIn), undefined);
        for (const percent of [21, 80, 100]) {
            assert.equal(batteryStroke(percent, pluggedIn), pluggedIn ? "#34c759" : "#f2f2f7");
        }
    }
    assert.equal(batteryStroke(21, true, true), "#34c759");
});

test("System Stats can be the timed default and shares one sample between visible displays", async (t) => {
    let now = 1, reads = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.method(Date, "now", () => now);
    const untilIdle = () => new Promise((resolve) => setImmediate(resolve));
    const shared = createStatsSource(async () => ({ cpu: ++reads }));
    const settings = { defaultPage: "stats", returnSeconds: 1 };
    const make = (s) => new Infobar(s, () => true, async () => null, async () => null, shared);
    const first = make(settings), second = make({}), hidden = make({});
    try {
        second.draw();
        hidden.draw();
        assert.equal(reads, 0);
        first.draw();
        second.move(-1);
        await untilIdle();
        assert.equal(reads, 1);
        assert.match(first.sent, />1<\/text>/);
        now += 400;
        second.draw();
        assert.equal(second.page, "stats");
        first.move(1);
        now += 420;
        first.draw();
        assert.equal(first.page, "clock");
        first.returnAt = 0;
        first.draw();
        assert.equal(first.slide.to, "stats");
        now += 420;
        first.draw();
        assert.equal(first.page, "stats");
        first.update({ pages: [{ id: "stats", enabled: false }] });
        second.close();
        now += 5000;
        first.draw();
        hidden.draw();
        await untilIdle();
        assert.equal(reads, 1);
        first.update(settings);
        first.move(-1);
        now += 420;
        first.draw();
        await untilIdle();
        assert.equal(first.page, "stats");
        assert.equal(reads, 2);
    } finally {
        first.close();
        second.close();
        hidden.close();
    }
});

test("Linux stats use available RAM, GPU utilization, and a system battery", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clocky-sensors-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    async function sensor(key, value) {
        const file = path.join(dir, key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, value);
    }
    await Promise.all([
        sensor("meminfo", "MemTotal: 10000 kB\nMemAvailable: 2500 kB\n"),
        sensor("drm/card0/device/gpu_busy_percent", "0\n"),
        sensor("drm/card1/device/gpu_busy_percent", "48\n"),
        sensor("power_supply/BAT0/type", "Battery"), sensor("power_supply/BAT0/capacity", "67"),
        sensor("power_supply/BAT0/status", "Charging"),
        sensor("power_supply/Accessory/type", "Battery"), sensor("power_supply/Accessory/capacity", "100"),
        sensor("power_supply/Accessory/scope", "Device"),
    ]);
    const read = () => linuxStats(dir, path.join(dir, "meminfo"));
    assert.deepEqual(await read(), { gpu: 48, ram: 75, battery: 67, charging: true, pluggedIn: true });
    await Promise.all([
        sensor("power_supply/AC/type", "Mains"), sensor("power_supply/AC/online", "0"),
        sensor("power_supply/USB/type", "USB"), sensor("power_supply/USB/online", "1"),
        sensor("power_supply/BAT0/status", "Not charging"),
        sensor("power_supply/Peripheral/type", "USB"), sensor("power_supply/Peripheral/online", "1"),
        sensor("power_supply/Peripheral/scope", "Device"),
    ]);
    assert.deepEqual(await read(), { gpu: 48, ram: 75, battery: 67, charging: false, pluggedIn: true });
    await sensor("power_supply/USB/online", "0");
    assert.equal((await read()).pluggedIn, false);
    assert.deepEqual(await linuxStats(path.join(dir, "absent"), path.join(dir, "absent")), { gpu: null, ram: null });
});

test("Now Playing gives 9 px timestamps a six-pixel gap on both sides of its timeline", () => {
    const track = { title: "Song", position: 12, duration: 180, playing: false };
    const render = (t) => mediaScreen(t, new Date(0), () => "");
    assert.match(render(track), /font-size="9" font-weight="500"/);
    assert.match(render(track), /<svg x="87" y="35.5" width="102" height="5"/);
    assert.match(render(track), /00:12<\/text>.*03:00<\/text>/s);
    const long = render({ ...track, position: 6120, duration: 8120 });
    const box = /<svg x="([\d.]+)" y="35.5" width="([\d.]+)"/.exec(long);
    assert.ok(+box[1] > 87 && +box[2] < 102);
});

test("Sonic frame-rate changes apply to mounted and newly assigned displays", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    t.mock.method(performance, "now", () => Date.now());
    const messages = [];
    const socket = { readyState: 1, bufferedAmount: 0, send(raw) { messages.push(JSON.parse(raw)); } };
    startSession(socket, "clocky", "registerPlugin", async () => null, async () => 0);
    const emit = (data) => socket.onmessage({ data: JSON.stringify(data) });
    const key = (profile) => {
        for (const event of ["keyDown", "keyUp"]) {
            emit({ event, device: "neo", context: "neo." + profile + ".Keypad.1.0", action: "dev.clocky.neo.next" });
        }
    };
    const mount = (profile) => emit({ event: "willAppear", device: "neo", context: "neo." + profile + ".Infobar.0.0", action: "dev.clocky.neo.clockface" });
    function swipe(profile) {
        messages.length = 0;
        key(profile);
        for (let ms = 0; ms < 370; ms++) t.mock.timers.tick(1);
        const frames = messages.filter((m) => m.context === "neo." + profile + ".Infobar.0.0");
        assert.doesNotMatch(Buffer.from(frames.at(-1).payload.image.split(",")[1], "base64").toString(), /swipe-card/);
        return frames.length;
    }
    try {
        socket.onopen();
        assert.equal(messages[0].subscribeFrameRate, true);
        mount("a");
        const standard = swipe("a");
        emit({ event: "sonicFrameRateDidChange", payload: { fps: 60 } });
        assert.ok(swipe("a") >= standard + 9);
        mount("b");
        assert.ok(swipe("b") >= standard + 9);
        emit({ event: "sonicFrameRateDidChange", payload: { fps: 30 } });
        assert.ok(Math.abs(swipe("b") - standard) <= 1);
    } finally {
        socket.onclose();
    }
});

test("Sonic receives one swipe command and independent media layers", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
    t.mock.method(performance, "now", () => Date.now());
    const messages = [], media = async () => null;
    let notify;
    media.subscribe = fn => { notify = fn; return () => {}; };
    const socket = {readyState:1, bufferedAmount:0, send(raw) { messages.push(JSON.parse(raw)); }};
    startSession(socket, "clocky", "registerPlugin", media, async () => 0);
    const ctx = "neo.p.Infobar.0.0";
    const emit = (event, data) => socket.onmessage({data:JSON.stringify({event, ...data})});
    try {
        emit("willAppear",{action:"dev.clocky.neo.clockface", device:"neo", context:ctx, sonicInfobar:true});
        assert.deepEqual(messages.map(m=>m.event),["sonicRequestInfobar"]);
        emit("sonicInfobarMode",{context:ctx,payload:{enabled:true}});
        const track = {title:"A long scrolling song title ".repeat(4),artist:"Artist",playing:true,position:16,duration:180,sampledAt:Date.now()};
        notify(track);
        emit("keyDown",{action:"dev.clocky.neo.next",device:"neo",context:"neo.p.Keypad.1.0"});
        emit("keyUp",{action:"dev.clocky.neo.next",device:"neo",context:"neo.p.Keypad.1.0"});
        const scene = messages.at(-1).payload;
        assert.equal(scene.direction,1);
        assert.equal(scene.rows.length,2);
        assert.ok(scene.rows[0].width>170);
        assert.match(scene.timeline,/00:16/);
        const count=messages.length;
        for(let i=0;i<359;i++) t.mock.timers.tick(1);
        assert.equal(messages.length,count);
        for(let i=0;i<2000;i++) t.mock.timers.tick(1);
        assert.ok(messages.slice(count).every(m => Object.keys(m.payload).sort().join() === "page,timeline"));
        assert.ok(messages.slice(count).length>0);
        assert.ok(messages.every(m=>m.event!=="setImage"));
        emit("sonicInfobarMode",{context:ctx,payload:{enabled:false}});
        assert.equal(messages.at(-1).event,"setImage");
    } finally {socket.onclose();}
});

test("holding either arrow pins the visible page and a tap switches and restarts automatic return", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
    t.mock.method(performance, "now", () => Date.now());
    const messages = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (raw) => messages.push(JSON.parse(raw)) };
    startSession(socket, "clocky", "registerPlugin", async () => null, async () => 50,
        [{ id: "neo", type: 9 }], async () => ({ cpu: 10 }));
    const bar = "neo.p.Infobar.0.0";
    const previous = "neo.p.Keypad.8.0", next = "neo.p.Keypad.9.0", lcd = "neo.p.Keypad.1.0";
    const other = "neo.other.Keypad.9.0";
    function emit(event, context, extra = {}) {
        const action = context === bar ? "clockface" : context === previous ? "previous" : "next";
        socket.onmessage({ data: JSON.stringify({ event, context, device: "neo", action: "dev.clocky.neo." + action, ...extra }) });
    }
    const settings = (color) => ({ payload: { settings: { color } } });
    const tap = (key) => { emit("keyDown", key); emit("keyUp", key); };
    const advance = (ms) => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
    const scenes = () => messages.filter((m) => m.event === "sonicInfobarScene" && "direction" in m.payload).map((m) => m.payload.page);
    function color(id) {
        const image = messages.findLast((m) => m.context === id && m.event === "setImage").payload.image;
        return Buffer.from(image.split(",")[1], "base64").toString().match(/(?:stroke|fill)="(#[0-9a-f]{6})"/)[1];
    }
    try {
        emit("willAppear", bar, { sonicInfobar: true, payload: { settings: { returnSeconds: 1 } } });
        emit("sonicInfobarMode", bar, { payload: { enabled: true } });
        emit("willAppear", previous, settings("#aa1100"));
        emit("willAppear", next, settings("#00aa22"));
        emit("willAppear", other, settings("#990099"));
        for (const [held, releaseKey] of [[previous, next], [next, previous]]) {
            tap(next);
            advance(900);
            assert.equal(scenes().at(-1), "media");
            const before = scenes();
            emit("keyDown", held);
            advance(1900);
            emit("keyDown", held); // Repeated down events cannot restart the three-second interval.
            advance(1099);
            assert.deepEqual(scenes(), before);
            assert.equal(color(previous), "#aa1100");
            assert.equal(color(next), "#00aa22");
            advance(1);
            assert.equal(color(previous), "#808080");
            assert.equal(color(next), "#808080");
            emit("willAppear", lcd, settings("#0011aa"));
            assert.equal(color(lcd), "#808080");
            assert.equal(color(other), "#990099");
            emit("keyUp", held);
            advance(5000);
            assert.deepEqual(scenes(), before);
            emit("didReceiveSettings", lcd, settings("#112233"));
            assert.equal(color(lcd), "#808080");
            tap(releaseKey);
            assert.equal(color(previous), "#aa1100");
            assert.equal(color(next), "#00aa22");
            assert.equal(color(lcd), "#112233");
            assert.equal(scenes().at(-1), releaseKey === next ? "usage" : "clock");
            advance(1800);
            assert.equal(scenes().at(-1), "clock");
        }
    } finally { socket.onclose(); }
});

test("disabling the pinned page clears its pin and interrupted presses cannot pin a replacement page", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
    t.mock.method(performance, "now", () => Date.now());
    const changes = [];
    const display = new Infobar({ defaultPage: "media" }, () => true, async () => null, async () => 0,
        async () => ({}), () => changes.push(display.pinned));
    try {
        display.draw();
        display.keyDown("right");
        t.mock.timers.tick(3000);
        assert.equal(display.pinned, true);
        display.update({ pages: [{ id: "media", enabled: false }] });
        display.keyUp("right", 1);
        assert.deepEqual(changes, [true, false]);
        assert.equal(display.page, "clock");
        assert.equal(display.slide, null);
        display.keyDown("left");
        display.cancelPress("left");
        t.mock.timers.tick(3100);
        display.keyUp("left", -1);
        assert.equal(display.slide, null);
        display.keyDown("right");
    } finally { display.close(); }
    t.mock.timers.tick(4000);
    assert.deepEqual(changes, [true, false]);
});

test("release distinguishes a 2999 ms tap from a hold even if the event loop delivers keyUp before the timeout", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const display = new Infobar({}, () => true, async () => null, async () => 0);
    try {
        display.keyDown("previous");
        now = 3000;
        display.keyUp("previous", -1);
        assert.ok(display.pinned);
        assert.equal(display.page, "clock");
        assert.equal(display.slide, null);
        display.keyDown("next");
        now += 2999;
        display.keyUp("next", 1);
        assert.equal(display.pinned, false);
        assert.equal(display.slide.to, "media");
        display.keyUp("next", 1);
        assert.deepEqual(display.queue, []);
    } finally { display.close(); }
});

for (const native of [false, true]) {
    test(`pin confirmation slides up, holds for two seconds, and slides down on ${native ? "Sonic" : "OpenDeck"}`, (t) => {
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
        t.mock.method(performance, "now", () => Date.now());
        const updates = [];
        const publish = (art) => { updates.push(art); return true; };
        const display = new Infobar({ returnSeconds: 1, face: "mint" }, publish, async () => null, async () => 73);
        if (native) display.setNative((scene) => publish(scene.base || ""));
        const advance = (ms) => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
        const y = () => {
            const match = /<image y="([\d.]+)" width="232" height="50"/.exec(updates.at(-1));
            return match ? Number(match[1]) : null;
        };
        try {
            display.draw();
            display.move(1);
            advance(400);
            display.keyDown("right");
            advance(3000);
            assert.equal(y(), 50);
            display.keyUp("right", 1);
            advance(150);
            assert.ok(y() > 0 && y() < 50);
            advance(150);
            assert.equal(y(), 0);
            const atRest = updates.length;
            advance(1999);
            assert.equal(updates.length, atRest);
            advance(151);
            assert.ok(y() > 0 && y() < 50);
            advance(150);
            assert.equal(y(), null);
            assert.equal(display.page, "media");
            advance(1500);
            assert.ok(display.pinned);
            assert.equal(display.returnAt, null);
            display.keyDown("left");
            advance(3100);
            display.keyUp("left", -1);
            assert.equal(y(), null); // A second hold on an already pinned page is quiet.
            display.move(-1);
            advance(400);
            display.pinPage();
            advance(450);
            assert.equal(y(), 0);
            display.keyDown("right");
            display.keyUp("right", 1);
            advance(400);
            assert.equal(display.page, "media");
            assert.equal(display.pinNotice, null);
            assert.equal(display.pinned, false);
            advance(1500);
            assert.equal(display.page, "clock");
        } finally { display.close(); }
    });
}

test("the pin confirmation receives its full dwell after a congested transport accepts the artwork", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
    t.mock.method(performance, "now", () => Date.now());
    let blocked = true;
    const display = new Infobar({}, () => !blocked, async () => null, async () => null);
    const advance = (ms) => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
    try {
        display.pinPage();
        advance(1200);
        assert.equal(display.pinNotice.leaveAt, undefined);
        blocked = false;
        display.draw();
        assert.equal(display.pinNotice.leaveAt, Date.now() + 2000);
        advance(2300);
        assert.equal(display.pinNotice, null);
        assert.ok(display.pinned);
    } finally { display.close(); }
});

for (const native of [false, true]) {
    test(`song starts and changes visit Now Playing for two settled seconds on ${native ? "Sonic" : "OpenDeck"}`, (t) => {
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
        t.mock.method(performance, "now", Date.now);
        const advance = ms => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
        const source = async () => null;
        let push;
        source.subscribe = fn => { push = fn; return () => {}; };
        const settings = { showNowPlaying: true, returnSeconds: 1 };
        const bar = new Infobar(settings, () => true, source, async () => null, async () => ({}));
        const a = { title: "One", trackId: "a", playing: true };
        try {
            if (native) bar.setNative(() => true);
            else bar.draw();
            push(a, true); // The track already playing at registration is a baseline.
            assert.equal(bar.slide, null);
            bar.move(-1);
            advance(370);
            assert.equal(bar.page, "stats");
            push({ ...a, playing: false });
            push(a);
            assert.equal(bar.slide.to, "media");
            advance(360);
            assert.equal(bar.page, "media");
            advance(1600);
            push({ ...a, artwork: "data:image/png;base64,YQ==", position: 23 });
            advance(399);
            assert.equal(bar.slide, null);
            advance(1);
            assert.equal(bar.slide.to, "stats");
            advance(360);
            assert.equal(bar.page, "stats");
            assert.ok(bar.returnAt > Date.now());
            push({ ...a, trackId: "b" });
            advance(360 + 1400);
            push({ title: "Three", playing: true });
            advance(1999);
            assert.equal(bar.slide, null);
            advance(1);
            assert.equal(bar.slide.to, "stats");
            advance(360);
            bar.keyDown("prev");
            push({ title: "Four", playing: true });
            advance(3000);
            bar.keyUp("prev", -1);
            assert.ok(bar.pinned);
            push({ title: "Five", playing: true });
            assert.equal(bar.mediaVisit, null);
            bar.move(1);
            advance(360);
            assert.equal(bar.page, "clock");
            push({ title: "Six", playing: true });
            advance(360);
            bar.move(1);
            advance(360);
            assert.equal(bar.page, "usage");
            assert.equal(bar.mediaVisit, null);
            bar.update({ ...settings, showNowPlaying: false });
            push({ title: "Seven", playing: true });
            assert.equal(bar.slide, null);
            bar.update({ ...settings, pages: [{ id: "media", enabled: false }] });
            assert.equal(bar.mediaVisit, null);
        } finally { bar.close(); }
    });
}

test("opted-in displays share off-screen playback polling and stop it when disabled", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    t.mock.method(performance, "now", Date.now);
    let reads = 0, track = null;
    const source = createMediaSource({ watch: null, readTrack: async () => { reads++; return track; } });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const make = () => new Infobar({ showNowPlaying: true }, () => true, source, async () => null);
    const a = make(), b = make();
    try {
        a.draw(); b.draw();
        t.mock.timers.tick(1);
        await settle();
        assert.equal(reads, 1);
        track = { title: "New song", playing: true };
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(reads, 2);
        assert.equal(a.slide.to, "media");
        assert.equal(b.slide.to, "media");
        a.update({ showNowPlaying: false });
        b.update({ pages: [{ id: "media", enabled: false }] });
        a.close();
        t.mock.timers.tick(10000);
        await settle();
        assert.equal(reads, 2);
    } finally { a.close(); b.close(); }
});
