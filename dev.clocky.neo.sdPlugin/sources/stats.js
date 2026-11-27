"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: sleep } = require("node:timers/promises");
const run = promisify(execFile);
const statsInterval = 2000;

function cpuTimes() {
    let idle = 0, total = 0;
    for (const { times } of os.cpus()) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.irq + times.idle;
    }
    return { idle, total };
}

async function cpuPercent() {
    const start = cpuTimes();
    await sleep(180);
    const end = cpuTimes();
    const elapsed = end.total - start.total;
    return elapsed > 0 ? 100 * (1 - (end.idle - start.idle) / elapsed) : null;
}

async function readText(file) {
    return fs.readFile(file, "utf8").then((text) => text.trim(), () => "");
}

async function linuxStats(sys = "/sys/class", meminfo = "/proc/meminfo") {
    const [memory, cards, supplies] = await Promise.all([
        readText(meminfo), fs.readdir(path.join(sys, "drm")).catch(() => []),
        fs.readdir(path.join(sys, "power_supply")).catch(() => []),
    ]);
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]);
    const [loads, power] = await Promise.all([
        Promise.all(cards.filter((name) => /^card\d+$/.test(name)).map((card) =>
            readText(path.join(sys, "drm", card, "device/gpu_busy_percent"))
        )),
        Promise.all(supplies.sort().map(async (supply) => {
            const dir = path.join(sys, "power_supply", supply);
            const [type, scope] = await Promise.all(["type", "scope"].map((key) => readText(path.join(dir, key))));
            if (scope === "Device") return null;
            if (type !== "Battery") {
                const online = await readText(path.join(dir, "online"));
                return /^\d+$/.test(online) ? { online: Number(online) > 0 } : null;
            }
            const [capacity, status] = await Promise.all(["capacity", "status"].map(
                (key) => readText(path.join(dir, key)),
            ));
            if (!/^\d+$/.test(capacity)) return null;
            return { battery: Number(capacity), charging: status === "Charging" };
        })),
    ]);
    const active = loads.filter((value) => /^\d+$/.test(value)).map(Number);
    const battery = power.find((supply) => supply?.battery !== undefined);
    const adapters = power.filter((supply) => supply?.online !== undefined);
    if (battery) battery.pluggedIn = adapters.length ? adapters.some((supply) => supply.online) : battery.charging;
    return {
        gpu: active.length ? Math.max(...active) : null,
        ram: total > 0 && Number.isFinite(available) ? 100 * (1 - available / total) : null,
        ...battery,
    };
}

async function platformStats() {
    if (process.platform === "linux") return linuxStats();
    let command, args;
    if (process.platform === "darwin") {
        command = path.join(__dirname, "mac-stats");
        args = [];
    } else if (process.platform === "win32") {
        command = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "windows-stats.ps1")];
    } else return {};
    const result = await run(command, args, { timeout: 4000, maxBuffer: 65536, windowsHide: true });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

async function sample() {
    const [cpu, sensors] = await Promise.all([cpuPercent().catch(() => null), platformStats().catch(() => ({}))]);
    const ram = sensors.ram ?? 100 * (1 - os.freemem() / os.totalmem());
    return { ...sensors, ram, cpu };
}

// All Infobars in a session share one short-lived sample. No polling runs off-screen.
function createStatsSource(read = sample) {
    let pending, value, expires = 0;
    return function getStats() {
        if (performance.now() < expires) return Promise.resolve(value);
        pending ??= Promise.resolve().then(read).then((result) => {
            value = result;
            expires = performance.now() + statsInterval;
            return value;
        }).finally(() => { pending = null; });
        return pending;
    };
}

module.exports = { createStatsSource, statsInterval, linuxStats };
