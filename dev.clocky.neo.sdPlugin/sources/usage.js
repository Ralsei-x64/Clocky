"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

function accountLimits() {
    return new Promise((resolve) => {
        const child = spawn("codex", ["app-server"], {
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
        });
        const lines = createInterface({ input: child.stdout });
        const timer = setTimeout(() => finish(null), 12000);
        let done = false;
        function finish(result) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            lines.close();
            child.stdin.end();
            child.kill();
            resolve(result);
        }
        function send(message) {
            child.stdin.write(JSON.stringify(message) + "\n");
        }
        child.on("error", () => finish(null));
        child.on("close", () => finish(null));
        child.stdin.on("error", () => finish(null));
        child.once(
            "spawn",
            () =>
                send({
                    id: 1,
                    method: "initialize",
                    params: { clientInfo: { name: "clocky", version: "1.1.0" } },
                }),
        );
        lines.on("line", (line) => {
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                return;
            }
            if (msg.id === 1 && msg.result) {
                send({ method: "initialized" });
                send({ id: 2, method: "account/rateLimits/read", params: {} });
            } else if (msg.id === 2) {
                finish(msg.result?.rateLimitsByLimitId?.codex ?? msg.result?.rateLimits ?? null);
            } else if (msg.error && msg.id === 1) finish(null);
        });
    });
}

function remaining(window, now = Date.now()) {
    const used = window?.usedPercent ?? window?.used_percent;
    const reset = window?.resetsAt ?? window?.resets_at;
    if (!Number.isFinite(used) || (Number.isFinite(reset) && reset * 1000 <= now)) return null;
    return Math.max(0, Math.min(100, 100 - used));
}

function windowFor(limits, mode) {
    if (!limits) return null;
    if (mode === "current") return limits.primary ?? limits.secondary;
    // A weekly-only plan reports its seven-day window in the primary slot.
    const minutes = (w) => w?.windowDurationMins ?? w?.window_minutes;
    return [limits.primary, limits.secondary].find((w) => minutes(w) === 7 * 24 * 60) ??
        (minutes(limits.secondary) == null ? limits.secondary ?? null : null);
}

function contextRemaining(info) {
    const window = info?.model_context_window, used = info?.last_token_usage?.total_tokens;
    if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(used)) return null;
    // Codex's status display reserves a 12k baseline before measuring usable context.
    if (window <= 12000) return 0;
    return Math.round(100 * Math.max(0, Math.min(1, (window - used) / (window - 12000))));
}

async function latestSession(root) {
    const entries = await fs.readdir(root, { recursive: true });
    const names = entries.filter((name) => /^rollout-.*\.jsonl$/.test(path.basename(name)));
    const files = [];
    for (let start = 0; start < names.length; start += 64) {
        const group = await Promise.all(
            names.slice(start, start + 64).map(async (name) => {
                const file = path.join(root, name);
                const stat = await fs.stat(file).catch(() => null);
                return stat && { file, time: stat.mtimeMs };
            }),
        );
        files.push(...group.filter(Boolean));
    }
    for (const { file } of files.sort((a, b) => b.time - a.time)) {
        const fd = await fs.open(file, "r").catch(() => null);
        if (!fd) continue;
        try {
            const header = Buffer.alloc(65536);
            const read = await fd.read(header, 0, header.length, 0);
            // Session metadata may include long base instructions. Inspect only its header.
            const meta = header.toString("utf8", 0, read.bytesRead).split("\n", 1)[0];
            if (/"source"\s*:\s*\{\s*"subagent"/.test(meta)) continue;
            return await latestUsage(fd);
        } finally {
            await fd.close();
        }
    }
    return null;
}

// Walk back until a complete usage event is found, even after a large tool response.
// Conversation text is never emitted, and memory use is bounded for long JSONL rows.
async function latestUsage(fd) {
    let end = (await fd.stat()).size, suffix = Buffer.alloc(0), skip = false;
    while (end > 0) {
        const start = Math.max(0, end - 65536);
        const block = Buffer.alloc(end - start);
        const { bytesRead } = await fd.read(block, 0, block.length, start);
        end = start;
        const data = Buffer.concat([block.subarray(0, bytesRead), suffix]);
        let right = data.length;
        for (let i = data.length - 1; i >= 0; i--) {
            if (data[i] !== 10) continue;
            if (!skip) {
                const value = usageLine(data.subarray(i + 1, right));
                if (value) return value;
            }
            skip = false;
            right = i;
        }
        if (right > 128 * 1024) skip = true;
        suffix = skip ? Buffer.alloc(0) : data.subarray(0, right);
    }
    return skip ? null : usageLine(suffix);
}

function usageLine(line) {
    if (!line.subarray(0, 256).includes('"token_count"')) return null;
    try {
        const event = JSON.parse(line.toString());
        if (event.type === "event_msg" && event.payload?.type === "token_count" && event.payload.info) {
            return {
                info: event.payload.info,
                limits: event.payload.rate_limits,
                time: Date.parse(event.timestamp),
            };
        }
    } catch { /* A writer can still be appending the final line. */ }
    return null;
}

function createUsageSource() {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
    let session, sessionAt = 0, reading, account, accountAt = 0, polling;
    async function local() {
        if (Date.now() - sessionAt < 10000) return session;
        reading ??= latestSession(root).catch(() => null).then((value) => {
            session = value;
            sessionAt = Date.now();
            reading = null;
            return value;
        });
        return reading;
    }
    return async function read(mode) {
        if (mode === "context") return contextRemaining((await local())?.info);
        if (Date.now() - accountAt >= 60000) {
            polling ??= accountLimits().then((value) => {
                account = value;
                accountAt = Date.now();
                polling = null;
            });
            await polling;
        }
        if (account) return remaining(windowFor(account, mode));
        const cached = await local();
        if (!cached || Date.now() - cached.time > 15 * 60000) return null;
        return remaining(windowFor(cached.limits, mode));
    };
}

module.exports = { createUsageSource, remaining, windowFor, contextRemaining, latestUsage, accountLimits };
