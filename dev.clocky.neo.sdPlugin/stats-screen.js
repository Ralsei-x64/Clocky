"use strict";

const paths = require("./assets/stats-paths.json");
const metrics = ["cpu", "gpu", "ram", "battery"];
const labels = metrics.map((key) => `<path fill="white" d="${paths[key]}"/>`).join("");

// Each 42 px gauge has a 240° arc, open at the bottom.
function arc(cx, fraction) {
    const radius = 16.597;
    const cy = 24.697;
    const start = `M${(cx - radius * Math.sqrt(3) / 2).toFixed(3)} ${(cy + radius / 2).toFixed(3)}`;
    if (fraction === 0) return start + " h0"; // A round cap keeps the empty battery warning visible.
    const end = (150 + 240 * fraction) * Math.PI / 180;
    const x = (cx + radius * Math.cos(end)).toFixed(3);
    const y = (cy + radius * Math.sin(end)).toFixed(3);
    return `${start} A${radius} ${radius} 0 ${fraction > .75 ? 1 : 0} 1 ${x} ${y}`;
}

function statsScreen(sample) {
    const gauges = metrics.map((key, index) => {
        const cx = 29 + index * 58;
        const value = sample?.[key];
        const known = Number.isFinite(value) && value >= 0 && value <= 100;
        const percent = known ? Math.round(value) : null;
        const battery = key === "battery";
        const warning = battery ? known && percent <= 20 : percent >= 80;
        let color = "#f2f2f7";
        if (warning) color = "#ff383c";
        else if (battery && sample?.pluggedIn) color = "#34c759";
        const fill = percent > 0 || (battery && percent === 0)
            ? `<path stroke="${color}" d="${arc(cx, percent / 100)}"/>` : "";
        const center = battery && sample?.charging === true
            ? `<path fill="white" d="${paths.bolt}"/>`
            : `<text x="${cx.toFixed(3)}" y="28.875">${percent ?? "—"}</text>`;
        return `<g fill="none" stroke-width="3.9375" stroke-linecap="round"><path stroke="#f2f2f7" opacity=".18" d="${arc(cx, 1)}"/>${fill}</g>${center}`;
    });
    return `<g fill="white" font-size="11.8125" font-family="'SF Pro Rounded', ui-rounded, -apple-system, sans-serif" font-weight="700" text-anchor="middle">${gauges.join("")}</g>${labels}`;
}

module.exports = { statsScreen };
