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

function sameSystemItem(a, b) {
    return a && b && a.title === b.title && a.sourceId === b.sourceId &&
        (!a.artist || !b.artist || a.artist === b.artist) && (!a.trackId || !b.trackId || a.trackId === b.trackId);
}

function systemItem(state) {
    return {
        title: state.title,
        artist: state.artist,
        trackId: state.contentItemIdentifier || state.uniqueIdentifier,
        sourceId: state.parentApplicationBundleIdentifier || state.bundleIdentifier,
    };
}

function systemTrack(state, now = Date.now(), previous) {
    if (!state?.title) return null;
    const track = systemItem(state);
    const prior = sameSystemItem(track, previous) ? previous : null;
    track.art = state.artworkData ? "data:image/auto;base64," + state.artworkData : prior?.art ?? null;
    track.trackId ??= prior?.trackId;
    track.artist ??= prior?.artist;
    track.playing = state.playing ?? prior?.playing ?? false;
    track.rate = Number.isFinite(state.playbackRate) && state.playbackRate !== 0 ? state.playbackRate : prior?.rate ?? 1;
    const duration = state.durationMicros != null ? state.durationMicros / 1e6 : state.duration;
    track.duration = duration > 0 ? duration : prior?.duration;
    const reported = state.elapsedTimeMicros != null ? state.elapsedTimeMicros / 1e6 : state.elapsedTime;
    const current = state.elapsedTimeNowMicros != null ? state.elapsedTimeNowMicros / 1e6 : state.elapsedTimeNow;
    const stamp = Number.isFinite(state.timestampEpochMicros) ? state.timestampEpochMicros / 1000 : Date.parse(state.timestamp);
    const age = track.playing && Number.isFinite(stamp) && state.playbackRate !== 0 ? Math.max(0, now - stamp) / 1000 : 0;
    let position = Number.isFinite(current) ? current : Number.isFinite(reported) ? reported + age * track.rate : null;
    const older = Number.isFinite(stamp) && prior?.stamp != null && stamp < prior.stamp;
    const sameAnchor = prior && (Number.isFinite(stamp) ? stamp : null) === prior.stamp && reported === prior.reported;
    if (older && position !== null && Number.isFinite(prior?.position)) {
        return { ...track, playing: prior.playing, rate: prior.rate, sampledAt: prior.sampledAt, position: prior.position,
            stamp: prior.stamp, reported: prior.reported, reportedNow: prior.reportedNow };
    }
    if (Number.isFinite(prior?.position) && (position === null ||
        (sameAnchor && (!Number.isFinite(current) || current === prior.reportedNow)))) {
        // Advance the last measurement up to this event using the previous transport state.
        // A pause freezes here. A resume starts here, excluding the time spent paused.
        position = prior.position + (prior.playing ? Math.max(0, now - prior.sampledAt) / 1000 * prior.rate : 0);
        return { ...track, position, sampledAt: now, stamp: prior.stamp, reported: prior.reported, reportedNow: prior.reportedNow };
    }
    return { ...track, position, sampledAt: now, stamp: Number.isFinite(stamp) ? stamp : null, reported, reportedNow: current };
}

const playheadFields = ["elapsedTimeMicros", "elapsedTime", "elapsedTimeNowMicros", "elapsedTimeNow"];
function systemEvents(onTrack, refresh, getPrevious) {
    let metadata, last;
    return (event) => {
        if (!event || typeof event.diff !== "boolean") return;
        const patch = event.payload;
        if (!patch) {
            metadata = last = null;
            return refresh();
        }
        const previous = getPrevious ? getPrevious() : last;
        const now = Date.now();
        // Keep metadata across stream diffs. Only pair elapsed time and timestamp from the same event.
        let state = event.diff ? { ...metadata, ...patch } : { ...patch };
        if (!state.title) return refresh();
        if (event.diff && previous) {
            if (!sameSystemItem(systemItem(state), previous)) {
                state = { bundleIdentifier: state.bundleIdentifier, parentApplicationBundleIdentifier: state.parentApplicationBundleIdentifier,
                    playing: state.playing, playbackRate: state.playbackRate, title: state.title, ...patch };
            } else {
                state.playing = patch.playing ?? previous.playing;
                state.playbackRate = patch.playbackRate ?? (previous.playing ? previous.rate : 0);
            }
        }
        metadata = { ...state };
        for (const field of [...playheadFields, "timestamp", "timestampEpochMicros"]) delete metadata[field];
        const measured = playheadFields.some(field => Number.isFinite(patch[field]));
        if (event.diff && measured && state.timestamp == null && state.timestampEpochMicros == null) {
            state.timestampEpochMicros = now * 1000;
        }
        const transport = "playing" in patch || "playbackRate" in patch;
        const metadataOnly = event.diff && !measured && !transport;
        last = systemTrack(state, now, previous);
        onTrack(last, metadataOnly);
        if (!event.diff || transport) refresh();
        else if (measured || "timestampEpochMicros" in patch || "timestamp" in patch) refresh(false);
    };
}

function watchMac(onTrack, onClose, refresh, getPrevious) {
    const child = spawn("media-control", ["stream", "--micros"], { stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const receive = systemEvents(onTrack, refresh, getPrevious);
    lines.on("line", (line) => {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        receive(event);
    });
    child.on("error", () => {}); // A missing reader also emits close. The one-shot fallback remains available.
    child.once("close", onClose);
    return () => {
        child.removeListener("close", onClose);
        lines.close();
        child.kill();
    };
}

async function macTrack(previous) {
    const args = ["get", "--now", "--micros"];
    const snapshot = async (metadataOnly) => systemTrack(JSON.parse(
        await output("media-control", metadataOnly ? [...args, "--no-artwork"] : args),
    ), Date.now(), previous);
    if (previous?.art) {
        const track = await snapshot(true);
        if (!track) return null;
        if (sameSystemItem(previous, track)) return { ...track, art: previous.art };
    }
    try {
        return await snapshot(false);
    } catch (error) {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return snapshot(true);
        throw error;
    }
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
    if (process.platform !== "darwin" || (kind && bytes.length < 4096)) {
        return kind ? "data:image/" + kind + ";base64," + bytes.toString("base64") : null;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clocky-cover-"));
    try {
        // ImageIO recognizes macOS artwork by its bytes, including TIFF labeled as JPEG.
        const input = path.join(dir, "input"), small = path.join(dir, "cover.jpg");
        await fs.writeFile(input, bytes);
        await output("/usr/bin/sips", ["-Z", "72", "-s", "format", "jpeg", input, "--out", small]);
        return "data:image/jpeg;base64," + await fs.readFile(small, "base64");
    } finally {
        await fs.rm(dir, { force: true, recursive: true });
    }
}

async function readPlatformTrack(previous) {
    if (process.platform === "darwin") return macTrack(previous);
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
    let cached, lastTrack, pending, stopWatch, refreshTimer, revision = 0;
    let lastReadAt = -Infinity, refreshAt = Infinity;
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

    function accept(data, metadataOnly = false) {
        if (metadataOnly && sameSystemItem(lastTrack, data)) {
            data = { ...data, ...lastTrack, artist: data.artist ?? lastTrack.artist, trackId: data.trackId ?? lastTrack.trackId,
                art: data.art ?? lastTrack.art, duration: data.duration ?? lastTrack.duration };
        }
        lastTrack = data;
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
                    sampledAt: data.sampledAt ?? Date.now(),
                    artwork: currentEntry?.image ?? null,
                }
                : null,
        );
    }

    function ensureWatch() {
        if (!watch || !listeners.size || stopWatch || Date.now() < nextWatch) return;
        stopWatch = watch((data, metadataOnly) => {
            if (!metadataOnly || !sameSystemItem(lastTrack, data)) revision++;
            accept(data, metadataOnly);
        }, () => {
            stopWatch = null;
            nextWatch = Date.now() + 30000;
            refresh();
        }, refresh, () => lastTrack);
    }

    // Coalesce a burst of transport changes into one authoritative snapshot.
    function refresh(transportChanged = true) {
        if (!listeners.size) return;
        const now = Date.now();
        const deadline = Math.max(now + 80, transportChanged ? now : lastReadAt + 1000);
        if (refreshTimer && refreshAt <= deadline) return;
        clearTimeout(refreshTimer);
        refreshAt = deadline;
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            nextPoll = 0;
            void read();
        }, deadline - now);
    }

    async function read() {
        ensureWatch();
        if (currentEntry && Date.now() >= currentEntry.retryAt) {
            currentEntry = coverFor(currentArt);
        }
        if (Date.now() >= nextPoll && !pending) {
            const atStart = revision;
            // A connected but silent stream can miss a pause, resume or seek.
            lastReadAt = Date.now();
            nextPoll = lastReadAt + (stopWatch ? 5000 : 1000);
            pending = readTrack(lastTrack).then((track) => {
                if (atStart === revision) {
                    if (track && !track.art && sameSystemItem(track, lastTrack)) track = { ...track, art: lastTrack.art };
                    accept(track);
                } else if (stopWatch && lastTrack?.position == null && Number.isFinite(track?.position) &&
                    sameSystemItem(track, lastTrack) && track.playing === lastTrack.playing && track.rate === lastTrack.rate) {
                    // A title-only notification can arrive during the first timed snapshot.
                    // Keep its metadata and fill the missing measurement for that same item.
                    accept({ ...track, ...lastTrack, position: track.position, sampledAt: track.sampledAt,
                        reported: track.reported, reportedNow: track.reportedNow, stamp: track.stamp,
                        duration: lastTrack.duration ?? track.duration, art: lastTrack.art ?? track.art });
                }
            }, () => {
                // A timed-out reader supplies no playback transition.
                if (atStart === revision && cached === undefined) publish(null);
            }).finally(() => {
                pending = null;
                if (nextPoll === 0 && listeners.size && !refreshTimer) refresh();
            });
        }
        if (pending) await pending;
        // A subscriber receives metadata immediately and a second update as soon as its cover is ready.
        if (!listeners.size) await currentEntry?.ready;
        return cached;
    }

    // One background check is shared by all Infobars with song notifications enabled.
    function scheduleMonitor(delay = Math.max(1, nextPoll - Date.now())) {
        if (!monitors) {
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

    read.refresh = refresh;
    read.subscribe = (listener) => {
        listeners.add(listener);
        if (cached !== undefined) listener(cached, true);
        ensureWatch();
        if (cached === undefined) void read();
        return () => {
            listeners.delete(listener);
            if (listeners.size) return;
            revision++;
            clearTimeout(refreshTimer);
            refreshTimer = undefined;
            stopWatch?.();
            stopWatch = null;
            cached = lastTrack = currentArt = currentEntry = undefined;
            nextPoll = nextWatch = 0;
        };
    };
    return read;
}
module.exports = { createMediaSource, systemTrack, systemEvents };
