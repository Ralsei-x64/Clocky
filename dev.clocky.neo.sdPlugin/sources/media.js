"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createInterface } = require("node:readline");
const run = require("node:util").promisify(execFile);

async function output(file, args, timeout = 5500) {
    const { stdout } = await run(file, args, { timeout, maxBuffer: 6 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
}

function systemTrack(state, now = Date.now()) {
    if (!state?.title) return null;
    const rate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
    // Some browsers publish the title but omit the timeline entirely.
    const reported = state.elapsedTimeMicros != null ? state.elapsedTimeMicros / 1e6 : state.elapsedTime;
    const sinceSample = Number.isFinite(state.timestampEpochMicros) && state.playing
        ? Math.max(0, (now - state.timestampEpochMicros / 1000) / 1000) * rate
        : 0;
    const position = state.elapsedTimeNow ?? (Number.isFinite(reported) ? reported + sinceSample : null);
    return {
        title: state.title,
        artist: state.artist,
        trackId: state.contentItemIdentifier || state.uniqueIdentifier,
        duration: state.durationMicros != null ? state.durationMicros / 1e6 : state.duration,
        playing: state.playing,
        rate,
        position,
        art: state.artworkData ? "data:image/auto;base64," + state.artworkData : null,
    };
}

function watchMac(onTrack, onClose) {
    const child = spawn("media-control", ["stream", "--micros"], { stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let state;
    lines.on("line", (line) => {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        if (!event || typeof event.diff !== "boolean") return;
        // Full events start a new item. Later events can contain only its artwork or timeline.
        state = event.diff && event.payload ? { ...state, ...event.payload } : event.payload;
        onTrack(systemTrack(state));
    });
    child.on("error", () => {}); // A missing reader also emits close. The one-shot fallback remains available.
    child.once("close", onClose);
    return () => {
        child.removeListener("close", onClose);
        lines.close();
        child.kill();
    };
}

async function macTrack() {
    try {
        const track = systemTrack(JSON.parse(await output("media-control", ["get", "--now"])));
        if (track) return track;
    } catch (error) {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            const track = systemTrack(
                await output("media-control", ["get", "--now", "--no-artwork"]).then(JSON.parse).catch(() =>
                    null
                ),
            );
            if (track) return track;
        }
    }
    return JSON.parse(
        await output("/usr/bin/osascript", ["-l", "JavaScript", path.join(__dirname, "mac-player.jxa")]),
    );
}

async function linuxTrack() {
    const sep = "\u001f";
    const format = [
        "{{status}}",
        "{{position}}",
        "{{mpris:length}}",
        "{{title}}",
        "{{artist}}",
        "{{mpris:artUrl}}",
        "{{mpris:trackid}}",
    ].join(sep);
    const metadata = await output("playerctl", ["--all-players", "metadata", "--format", format]).catch(error => {
        if (error.code === 1 && /no players found/i.test(error.stderr)) return "";
        throw error;
    });
    const rows = metadata.split("\n").map((row) => row.split(sep));
    const selected = rows.find((row) => row[0] === "Playing" && row[3]) ||
        rows.find((row) => row[0] === "Paused" && row[3]);
    if (!selected) return null;
    const [status, position, duration, title, artist, art, trackId] = selected;
    return {
        title,
        artist,
        art,
        trackId,
        playing: status === "Playing",
        position: Number(position) / 1e6,
        duration: Number(duration) / 1e6,
    };
}

async function artwork(url) {
    if (!url || typeof url !== "string") return null;
    const limit = 4 * 1024 * 1024;
    let bytes;
    if (url.startsWith("data:image/")) bytes = Buffer.from(url.split(",", 2)[1] || "", "base64");
    else if (url.startsWith("file:")) {
        const file = fileURLToPath(url);
        if ((await fs.stat(file)).size > limit) return null;
        bytes = await fs.readFile(file);
    } else if (/^https?:\/\//i.test(url)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (!response.ok || Number(response.headers.get("content-length")) > limit) {
            await response.body?.cancel();
            return null;
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) return null;
            chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
    }
    if (!bytes?.length || bytes.length > limit) return null;
    const kind = bytes[0] === 255 && bytes[1] === 216
        ? "jpeg"
        : bytes.readUInt8(0) === 137 && bytes.toString("ascii", 1, 4) === "PNG"
        ? "png"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : null;
    if (!kind) return null;
    if (process.platform !== "darwin" || bytes.length < 4096) {
        return "data:image/" + kind + ";base64," + bytes.toString("base64");
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clocky-cover-"));
    try {
        const input = path.join(dir, "input." + kind), small = path.join(dir, "cover.jpg");
        await fs.writeFile(input, bytes);
        await output("/usr/bin/sips", ["-Z", "72", "-s", "format", "jpeg", input, "--out", small]);
        return "data:image/jpeg;base64," + await fs.readFile(small, "base64");
    } finally {
        await fs.rm(dir, { force: true, recursive: true });
    }
}

async function readPlatformTrack() {
    if (process.platform === "darwin") return macTrack();
    if (process.platform !== "win32") return linuxTrack();
    return JSON.parse(
        await output("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.join(__dirname, "windows-player.ps1"),
        ], 9000),
    );
}

function createMediaSource({
    readTrack = readPlatformTrack,
    watch = process.platform === "darwin" ? watchMac : null,
    loadArtwork = artwork,
} = {}) {
    const listeners = new Set();
    const covers = new Map();
    let cached, pending, stopWatch, streamHasTrack = false, revision = 0;
    let nextWatch = 0, nextPoll = 0, currentArt, currentEntry;
    let monitors = 0, monitorTimer;

    function publish(track) {
        const initial = cached === undefined;
        cached = track;
        for (const listener of listeners) listener(track, initial);
    }

    function coverFor(art) {
        if (!art) return;
        if (art === currentArt && currentEntry && Date.now() < currentEntry.retryAt) return currentEntry;
        // Raw embedded covers can be several MB. Only keep their small thumbnails in the cache.
        const key = art.startsWith("data:") ? createHash("sha256").update(art).digest("hex") : art;
        let entry = covers.get(key);
        covers.delete(key);
        if (!entry || Date.now() >= entry.retryAt) {
            entry = { image: null, retryAt: Infinity };
            entry.ready = loadArtwork(art).catch(() => null).then((image) => {
                entry.image = image;
                if (!image) entry.retryAt = Date.now() + 5000;
                if (image && currentEntry === entry && cached) publish({ ...cached, artwork: image });
            });
        }
        covers.set(key, entry);
        if (covers.size > 8) covers.delete(covers.keys().next().value);
        return entry;
    }

    function accept(data) {
        currentEntry = coverFor(data?.art);
        currentArt = data?.art;
        publish(
            data?.title
                ? {
                    title: String(data.title),
                    artist: String(data.artist || ""),
                    trackId: data.trackId,
                    position: Number.isFinite(data.position) ? Math.max(0, data.position) : null,
                    duration: Number(data.duration) > 0 ? Number(data.duration) : null,
                    playing: !!data.playing,
                    rate: data.rate ?? 1,
                    sampledAt: Date.now(),
                    artwork: currentEntry?.image ?? null,
                }
                : null,
        );
    }

    function ensureWatch() {
        if (!watch || !listeners.size || stopWatch || Date.now() < nextWatch) return;
        stopWatch = watch((data) => {
            revision++;
            streamHasTrack = !!data?.title;
            if (!streamHasTrack) nextPoll = 0;
            accept(data);
            scheduleMonitor();
        }, () => {
            stopWatch = null;
            streamHasTrack = false;
            nextPoll = 0;
            nextWatch = Date.now() + 30000;
            scheduleMonitor();
        });
    }

    async function read() {
        ensureWatch();
        if (streamHasTrack && currentEntry && Date.now() >= currentEntry.retryAt) {
            currentEntry = coverFor(currentArt);
        }
        if (!streamHasTrack && Date.now() >= nextPoll && !pending) {
            const atStart = revision;
            pending = readTrack().then((track) => {
                if (atStart === revision) accept(track);
            }, () => {
                // A timed-out reader supplies no playback transition.
                if (atStart === revision && cached === undefined) publish(null);
            }).finally(() => {
                if (atStart === revision) nextPoll = Date.now() + 900;
                pending = null;
            });
        }
        if (pending && !streamHasTrack) await pending;
        // A subscriber receives metadata immediately and a second update as soon as its cover is ready.
        if (!listeners.size) await currentEntry?.ready;
        return cached;
    }

    // A single fallback poll serves every opted-in Infobar. A live stream needs no polling.
    function scheduleMonitor(delay = 1000) {
        if (!monitors || streamHasTrack || (stopWatch && cached === null)) {
            clearTimeout(monitorTimer);
            monitorTimer = undefined;
        } else if (!monitorTimer) {
            const timer = monitorTimer = setTimeout(async () => {
                try {
                    await read();
                } finally {
                    if (timer === monitorTimer) {
                        monitorTimer = undefined;
                        scheduleMonitor();
                    }
                }
            }, delay);
        }
    }

    read.monitorPlayback = () => {
        monitors++;
        scheduleMonitor(0);
        return () => {
            monitors--;
            scheduleMonitor();
        };
    };

    read.subscribe = (listener) => {
        listeners.add(listener);
        if (cached !== undefined) listener(cached, true);
        ensureWatch();
        if (!watch && cached === undefined) void read();
        return () => {
            listeners.delete(listener);
            if (listeners.size) return;
            revision++;
            stopWatch?.();
            stopWatch = null;
            streamHasTrack = false;
            cached = currentArt = currentEntry = undefined;
            nextPoll = nextWatch = 0;
        };
    };
    return read;
}
module.exports = { createMediaSource, systemTrack };
