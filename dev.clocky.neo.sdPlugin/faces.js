"use strict";

const faces = {
    normal: "Normal",
    almanac: "Almanac",
    flare: "Flare",
    graphite: "Graphite",
    mint: "Mint",
    evergreen: "Evergreen",
    ember: "Ember",
    clouds: "Clouds",
    "blue-hour": "Blue Hour",
    dots: "Dots",
    "dots-dark": "Dots (Dark)",
    "flux-a": "Flux-A",
    "flux-a-dark": "Flux-A (Dark)",
    "flux-b": "Flux-B",
    "flux-b-dark": "Flux-B (Dark)",
    "flux-c": "Flux-C",
    "flux-c-dark": "Flux-C (Dark)",
    "flux-d": "Flux-D",
    "flux-d-dark": "Flux-D (Dark)",
};
const fluxColors = {
    "flux-a": { paper: "#d9d9d9", ink: "#2e2e2e" },
    "flux-a-dark": { paper: "#131313", ink: "#d9d9d9" },
    "flux-b": { paper: "#a3d8ff", ink: "#003662" },
    "flux-b-dark": { paper: "#28577e", ink: "#a3d8ff" },
    "flux-c": { paper: "#ff6600", ink: "#000000" },
    "flux-c-dark": { paper: "#000000", ink: "#ff6600" },
    "flux-d": { paper: "#00ff8c", ink: "#000000" },
    "flux-d-dark": { paper: "#000000", ink: "#00ff8c" },
};
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const quotaLabels = { current: "Usage Limit", weekly: "Weekly Limit", context: "Context Left" };
const fontData = typeof module === "object" ? require("./assets/glyphs.js") : clockFonts;

function faceFor(settings) {
    return Object.hasOwn(faces, settings?.face) ? settings.face : "normal";
}

function quotaFor(settings) {
    return Object.hasOwn(quotaLabels, settings?.quota) ? settings.quota : "current";
}

function returnSecondsFor(settings) {
    const seconds = settings?.returnSeconds;
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 30;
}

function escapeXML(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function imageTag(src, x, y, w, h, extra = "") {
    return `<image x="${x}" y="${y}" width="${w}" height="${h}" xlink:href="${escapeXML(src)}" ${extra}/>`;
}

// Position the original glyph outlines using font advances and pair kerning.
function lettering(text, family, size, x, y, align = "left") {
    const { glyphs, kerning } = fontData[family];
    const scale = size / 1000;
    let advance = 0, previous = "";
    const paths = [];
    for (const ch of text) {
        advance += kerning[previous + ch] ?? 0;
        const [width, d] = glyphs[ch];
        if (d) paths.push(`<path transform="translate(${advance} 0)" d="${d}"/>`);
        advance += width;
        previous = ch;
    }
    if (align === "right") x -= advance * scale;
    if (align === "center") x -= advance * scale / 2;
    return `<g transform="translate(${x} ${y}) scale(${scale} ${-scale})">${paths.join("")}</g>`;
}

// Numeral paths are in Infobar pixels so the outline has the same weight in both renderers.
const blueNumerals = [
    "M30 0H0V19H30ZM30 0L0 19",
    "M0 0H30V20.9",
    "M0 0H34.2V9.5H3.8V19H38",
    "M0 0H30V19H0M30 9.5H15",
    "M30 -1.9V20.9M30 9.5H0V-1.9",
    "M38 0H3.8V9.5H34.2V19H0",
    "M30 3.8V0H0V19H30V9.5H0",
    "M0 0H33.75V6.2168L3.75 16.7542V20.9",
    "M0 0H30V5.4302L0 13.5698V19H30V13.5698L0 5.4302Z",
    "M0 15.2V19H30V0H0V9.5H30",
];

function blueHour(time) {
    const digits = time.replace(":", "");
    const paths = [9, 62, 137, 182].map((x, i) => {
        const n = digits[i];
        return `<path transform="translate(${x} 14.75)" vector-effect="non-scaling-stroke" stroke-width="3.727" d="${
            blueNumerals[n]
        }"/>`;
    });
    return `<g stroke="white" fill="none">${
        paths.join("")
    }<path stroke-width="1.864" d="M114 14.75h8v4h-8zM114 29.75h8v4h-8z"/></g>`;
}

function gradient(id, y1, y2, start, end, opacity = 1) {
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y1}" y2="${y2}"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}" stop-opacity="${opacity}"/></linearGradient>`;
}

function styledTime(face, time) {
    const wide = face === "flare", cloud = face === "clouds";
    const size = wide ? 34.8 : 43.0857;
    const glyphs = lettering(
        time,
        wide ? "wide" : "russo",
        size,
        cloud ? 220 : 115.5,
        wide ? 36 : 40,
        cloud ? "right" : "center",
    );
    const body = '<use xlink:href="#numbers"/>';
    const ink = wide
        ? gradient("ink", 13, 36, "red", "#ffc48e")
        : cloud
        ? gradient("ink", 10, 40, "white", "white", .49)
        : gradient("ink", 10, 40, "red", "#990000", 0);
    const defs = `<defs><g id="numbers">${glyphs}</g>${ink}
        <mask id="shape" maskUnits="userSpaceOnUse" x="0" y="0" width="232" height="50"><g fill="white">${body}</g></mask>
        <mask id="outside" maskUnits="userSpaceOnUse" x="0" y="0" width="232" height="50"><rect width="232" height="50" fill="white"/>${body}</mask>
        <filter id="glow" filterUnits="userSpaceOnUse" x="-80" y="-80" width="392" height="210"><feGaussianBlur stdDeviation="37.5"/></filter>
        <filter id="frost"><feGaussianBlur stdDeviation="2"/></filter></defs>`;
    const halo = wide
        ? `<g filter="url(#glow)" fill="#ff0b00">${body}</g>`
        : cloud
        ? `<g transform="translate(0 2)" opacity=".25">${body}</g>`
        : "";
    const under = cloud ? '<use xlink:href="#cloud-texture" filter="url(#frost)"/>' : "";
    const rim = wide ? "white" : cloud ? "black" : "red";
    // Strokes inherit the glyphs' 1000-unit transform. Mask away the inside half.
    const stroke = `<g mask="url(#outside)" opacity="${
        cloud ? .3 : 1
    }"><use xlink:href="#numbers" fill="none" stroke="${rim}" stroke-width="${2 * 1000 / size}"/></g>`;
    const rimLayer = face === "ember"
        ? `<defs><mask id="fade"><rect width="232" height="50" fill="url(#opacityRim)"/></mask>${
            gradient("opacityRim", 40, 24, "white", "black")
        }</defs><g mask="url(#fade)">${stroke}</g>`
        : stroke;
    return defs + halo + rimLayer +
        `<g mask="url(#shape)">${under}<rect width="232" height="50" fill="url(#ink)"/></g>`;
}

// Bitcount Prop Single's six-row numerals, including its narrower 1 and colon.
const dotRows = {
    0: [".###.", "#...#", "#...#", "#...#", "#...#", ".###."],
    1: [".#.", "##.", ".#.", ".#.", ".#.", "###"],
    2: [".###.", "#...#", "....#", ".###.", "#....", "#####"],
    3: ["#####", "....#", ".###.", "....#", "#...#", ".###."],
    4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#."],
    5: ["#####", "#....", "####.", "....#", "#...#", ".###."],
    6: [".###.", "#....", "####.", "#...#", "#...#", ".###."],
    7: ["#####", "....#", "...#.", "...#.", "..#..", "..#.."],
    8: [".###.", "#...#", ".###.", "#...#", "#...#", ".###."],
    9: [".###.", "#...#", "#...#", ".####", "....#", ".###."],
    ":": [".", ".", "#", ".", ".", "#"],
};

function dotsTime(time, hourColor) {
    let x = 0;
    const paths = Array.from(time, (ch, i) => {
        const rows = dotRows[ch];
        let d = "";
        rows.forEach((row, y) => {
            for (let col = 0; col < row.length; col++) {
                if (row[col] === "#") d += `M${x + col} ${y + .5}a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0Z`;
            }
        });
        x += rows[0].length + (ch === ":" ? 1 : 2);
        return `<path fill="${i < 3 ? hourColor : "#ff3f3f"}" d="${d}"/>`;
    });
    return `<g transform="translate(19 14.12) scale(3.48)">${paths.join("")}</g>`;
}

function clockForeground(face, now) {
    const two = (n) => String(n).padStart(2, "0");
    const time = two(now.getHours()) + ":" + two(now.getMinutes());
    if (fluxColors[face]) {
        // Flux has no colon glyph. Its two dots use the separator from the design.
        return `<g fill="${fluxColors[face].ink}">${lettering(time.slice(0, 2), "flux", 33.16394, 10.193, 35)}` +
            '<path d="M113.951 33.2091C113.951 32.3911 114.15 31.8163 114.548 31.4846C114.946 31.153 115.421 30.9872 115.974 30.9872C116.549 30.9872 117.035 31.153 117.433 31.4846C117.853 31.8163 118.063 32.3911 118.063 33.2091C118.063 34.0051 117.853 34.5799 117.433 34.9337C117.035 35.2874 116.549 35.4643 115.974 35.4643C115.421 35.4643 114.946 35.2874 114.548 34.9337C114.15 34.5799 113.951 34.0051 113.951 33.2091ZM113.951 19.015C113.951 18.1748 114.15 17.5889 114.548 17.2573C114.946 16.9257 115.421 16.7598 115.974 16.7598C116.549 16.7598 117.035 16.9257 117.433 17.2573C117.853 17.5889 118.063 18.1748 118.063 19.015C118.063 19.8109 117.853 20.3858 117.433 20.7395C117.035 21.0933 116.549 21.2701 115.974 21.2701C115.421 21.2701 114.946 21.0933 114.548 20.7395C114.15 20.3858 113.951 19.8109 113.951 19.015Z"/>' +
            lettering(time.slice(3), "flux", 33.16394, 120.437, 35) + "</g>";
    }
    switch (face) {
        case "dots":
        case "dots-dark":
            return dotsTime(time, face === "dots" ? "#2e2e2e" : "#d9d9d9") +
                `<g fill="${face === "dots" ? "black" : "#d9d9d9"}" opacity=".65">${lettering(
                months[now.getMonth()] + " " + now.getDate(), "shareTech", 21, 215, 32, "right",
            )}</g>`;
        case "normal":
            return '<defs><filter id="normal-shadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation=".5" flood-opacity=".25"/></filter></defs>' +
                `<g filter="url(#normal-shadow)" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif"><text x="13" y="37" font-size="34.8" font-weight="600" fill="white">${time}</text><text x="217" y="32" text-anchor="end" font-size="21" fill="#dfdfdf">${
                    months[now.getMonth()]
                } ${now.getDate()}</text></g>`;
        case "almanac": {
            const date = two(now.getDate()) + "/" + two(now.getMonth() + 1) + "/" + now.getFullYear();
            return `<g fill="#ffc972">${lettering(time, "serif", 34.8, 13, 37)}</g><g fill="#d5a762">${
                lettering(date, "serif", 21, 217, 32, "right")
            }</g>`;
        }
        case "mint":
        case "evergreen":
            return `<g fill="${face === "mint" ? "#2e604c" : "#d2ffe9"}">${
                lettering(time, "mintTime", 34.8, 13, 37)
            }${
                lettering(months[now.getMonth()] + " " + now.getDate(), "mintDate", 20, 211, 32, "right")
            }</g>`;
        case "graphite":
            return `<g fill="#d9d9d9">${lettering(time, "wide", 34.8, 115.5, 36, "center")}</g>`;
        case "blue-hour":
            return blueHour(time);
        default:
            return styledTime(face, time);
    }
}

function clockBackdrop(face, asset, background, tint) {
    const solid = {
        normal: "black",
        dots: "#d9d9d9",
        "dots-dark": "#0b0b0b",
        almanac: "#214635",
        flare: "#272727",
        graphite: "#272727",
        mint: "#d2ffe9",
        evergreen: "#193d2e",
    };
    const paper = fluxColors[face]?.paper ?? solid[face];
    const textureId = face === "clouds" ? ' id="cloud-texture"' : "";
    if (!background) {
        if (paper) return `<rect width="232" height="50" rx="10" fill="${paper}"/>`;
        return imageTag(asset(face), 0, 0, 232, 50, textureId);
    }
    const overlay = tint?.strength > 0
        ? `<rect width="232" height="50" fill="${tint.color}" opacity="${tint.strength / 100}"/>` : "";
    return '<defs><clipPath id="clock-background"><rect width="232" height="50" rx="10"/></clipPath></defs>' +
        `<g clip-path="url(#clock-background)"${textureId}>${imageTag(background, 0, 0, 232, 50)}${overlay}</g>`;
}

function clockLayer(face, now, asset, background, cache = {}, tint) {
    const minute = Math.floor(now.getTime() / 60000);
    const offset = now.getTimezoneOffset();
    if (cache.face !== face || cache.minute !== minute || cache.offset !== offset) {
        cache.art = clockForeground(face, now);
        cache.minute = minute;
        cache.offset = offset;
    }
    if (cache.face !== face || cache.image !== background || cache.asset !== asset ||
        cache.tintColor !== tint?.color || cache.tintStrength !== tint?.strength) {
        cache.backdrop = clockBackdrop(face, asset, background, tint);
        cache.image = background;
        cache.asset = asset;
        cache.tintColor = tint?.color;
        cache.tintStrength = tint?.strength;
    }
    cache.face = face;
    return { backdrop: cache.backdrop, art: cache.art };
}

function clockScreen(face, now, asset, background, tint) {
    const { backdrop, art } = clockLayer(face, now, asset, background, undefined, tint);
    return backdrop + art;
}

function meter(x, y, width, fraction, color) {
    const filled = Math.round(width * Math.max(0, Math.min(1, fraction || 0)) * 100) / 100;
    return `<svg x="${x}" y="${y}" width="${width}" height="5"><defs><clipPath id="bar-${width}"><rect width="${width}" height="5" rx="2.5"/></clipPath></defs><g clip-path="url(#bar-${width})"><rect width="${width}" height="5" fill="#1b1b1b"/><rect width="${filled}" height="5" fill="${color}"/></g></svg>`;
}

function quotaScreen(mode, remaining, asset) {
    const known = Number.isFinite(remaining);
    return imageTag(asset("usage-logo"), 12, 13.6, 23, 22.8) +
        `<g fill="white" font-size="12"><text x="45" y="22" font-weight="500">${quotaLabels[mode]}</text>
        <text font-family="ui-monospace, Menlo, monospace" x="220" y="22" text-anchor="end">${
            known ? Math.round(remaining) + "%" : "—"
        }</text></g>` +
        meter(45, 31.5, 175, known ? remaining / 100 : 0, "#007bff");
}

function durationText(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    seconds = Math.max(0, Math.floor(seconds));
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}

const labelViewport = 170;
const labelHoldMs = 1400;
const labelSpeed = 23; // Infobar pixels per second.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Arial advances for printable ASCII, in thousandths of an em. Keep label layout
// identical in OpenDeck's different SVG renderers by setting the SVG textLength.
// deno-fmt-ignore
const regularAdvances = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// deno-fmt-ignore
const boldAdvances = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function labelLayout(value, advances) {
    const text = String(value || "").trim().replace(/\s+/gu, " ");
    let units = 0;
    for (const { segment } of graphemes.segment(text.normalize("NFD"))) {
        if (/^[\p{Mark}\p{Cf}]+$/u.test(segment)) continue;
        if (
            /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u
                .test(segment)
        ) units += 1000;
        else units += advances[segment.codePointAt(0) - 32] ?? 580;
    }
    return { text, width: Math.ceil(units / 100) }; // 10 px type.
}

function mediaLabels(track) {
    const title = labelLayout(track?.title, boldAdvances);
    const artist = labelLayout(track?.artist, regularAdvances);
    return { title, artist, scrolls: Math.max(title.width, artist.width) > labelViewport };
}

function labelPhase(width, age) {
    return Math.max(0, age) % (labelHoldMs + (width + 24) * 1000 / labelSpeed);
}

function marqueeDelay(labels, age, interval) {
    function next(width) {
        if (width <= labelViewport) return Infinity;
        return Math.max(interval, labelHoldMs - labelPhase(width, age));
    }
    return Math.min(next(labels.title.width), next(labels.artist.width));
}

function labelRow(label, id, y, age) {
    if (!label.text) return "";
    const text = `<text id="${id}" y="${y}" textLength="${label.width}" lengthAdjust="spacingAndGlyphs">${
        escapeXML(label.text)
    }</text>`;
    if (label.width <= labelViewport) return text;
    const stride = label.width + 24;
    const phase = labelPhase(label.width, age);
    const offset = (Math.max(0, phase - labelHoldMs) * labelSpeed / 1000).toFixed(2);
    return `<g transform="translate(-${offset} 0)">${text}<use xlink:href="#${id}" x="${stride}"/></g>`;
}

function mediaCover(image) {
    return '<defs><clipPath id="cover"><rect x="9" y="8" width="34" height="34" rx="5"/></clipPath></defs>' +
        imageTag(image, 9, 8, 34, 34, 'clip-path="url(#cover)" preserveAspectRatio="xMidYMid slice"');
}

function mediaScreen(track, now, asset, labels = mediaLabels(track), age = 0, cover) {
    if (track === null) {
        return "<title>Nothing is playing...</title>" + imageTag(asset("media-idle"), 0, 0, 232, 50);
    }
    if (!track) {
        return imageTag(asset("album-placeholder"), 9, 8, 34, 34) +
            '<text x="53" y="28" fill="#b3b3b3" font-size="10">Reading Now Playing…</text>';
    }
    return (cover ?? mediaCover(track.artwork || asset("album-placeholder"))) +
        `<svg x="53" y="0" width="${labelViewport}" height="32" overflow="hidden" font-size="10" font-family="Arial, sans-serif">
        <g fill="white" font-weight="bold">${labelRow(labels.title, "media-title", 16, age)}</g>
        <g fill="#b3b3b3">${labelRow(labels.artist, "media-artist", 29, age)}</g></svg>` + mediaTimeline(track, now);
}

function mediaTimeline(track, now) {
    const position = Number.isFinite(track.position)
        ? track.position + (track.playing ? Math.max(0, now - track.sampledAt) / 1000 * (track.rate ?? 1) : 0)
        : null;
    const duration = track.duration;
    const elapsed = position !== null && duration > 0 ? Math.min(position, duration) : position;
    const currentTime = durationText(elapsed), totalTime = durationText(duration);
    const barStart = 53 + Math.max(28, currentTime.length * 5.6) + 6;
    const barEnd = 223 - Math.max(28, totalTime.length * 5.6) - 6;
    return `<g fill="white" font-size="9" font-weight="500" font-family="ui-monospace, Menlo, monospace"><text x="53" y="41">${
            currentTime
        }</text><text text-anchor="end" x="223" y="41">${totalTime}</text></g>` +
        meter(barStart, 35.5, Math.max(0, barEnd - barStart), duration > 0 ? elapsed / duration : 0, "white");
}

// Sonic rasterizes each unscrolled row once, then moves it inside the viewport.
function mediaSprites(labels) {
    return [labels.title, labels.artist].map((label, i) => ({
        width: label.width,
        svg: label.text ? `<text x="0" y="${i ? 9 : 16}" font-size="10" font-family="Arial, sans-serif" font-weight="${i ? "normal" : "bold"}" fill="${i ? "#b3b3b3" : "white"}" textLength="${label.width}" lengthAdjust="spacingAndGlyphs">${escapeXML(label.text)}</text>` : "",
    }));
}

function frame(layers, swiping = layers.length > 1) {
    const content = layers.map(({ art, backdrop = "", x = 0, scale = 1 }) => {
        const page = backdrop + art;
        if (!swiping) return page;
        return `<g transform="translate(${Number(x.toFixed(3))} 0)" clip-path="url(#swipe-card)"><g transform="translate(116 25) scale(${
            scale.toFixed(4)
        }) translate(-116 -25)" clip-path="url(#swipe-card)">${page}</g></g>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="248" height="58" viewBox="0 0 248 58" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"><rect width="248" height="58" fill="black"/><svg x="8" y="4" width="232" height="50" overflow="hidden">${
        swiping
            ? '<defs><clipPath id="swipe-card"><rect width="232" height="50" rx="10"/></clipPath></defs>'
            : ""
    }${content}</svg></svg>`;
}

if (typeof module === "object") {
    module.exports = {
        faces,
        faceFor,
        quotaFor,
        returnSecondsFor,
        clockScreen,
        clockLayer,
        mediaLabels,
        mediaCover,
        mediaTimeline,
        mediaSprites,
        marqueeDelay,
        mediaScreen,
        quotaScreen,
        frame,
    };
}
