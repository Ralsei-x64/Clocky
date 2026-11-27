"use strict";

function cropBackground(canvas, source, width, height) {
    const scale = Math.max(canvas.width / width, canvas.height / height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
        source,
        (canvas.width - width * scale) / 2,
        (canvas.height - height * scale) / 2,
        width * scale,
        height * scale,
    );
    return canvas.toDataURL("image/jpeg", 0.89);
}

async function importBackground(file, cancelled) {
    const canvas = document.createElement("canvas");
    canvas.width = 232;
    canvas.height = 50;
    const header = new Uint8Array(await file.slice(0, 6).arrayBuffer());
    if (!/^GIF8[79]a$/.test(String.fromCharCode(...header))) {
        const url = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            return {
                frames: [{ image: cropBackground(canvas, image, image.naturalWidth, image.naturalHeight) }],
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const gif = new GifReader(bytes);
    if (!gif.numFrames() || !gif.width || !gif.height || gif.width * gif.height > 16000000) {
        throw new Error("Choose a smaller GIF or one with readable frames.");
    }
    const source = document.createElement("canvas");
    source.width = gif.width;
    source.height = gif.height;
    const ctx = source.getContext("2d");
    const pixels = ctx.createImageData(gif.width, gif.height);
    const backgroundIndex = bytes[11];
    const paletteSize = (bytes[10] & 128) ? 1 << ((bytes[10] & 7) + 1) : 0;
    const base = 13 + backgroundIndex * 3;
    function clearArea(x, y, width, height, transparent) {
        const rgba = transparent || backgroundIndex >= paletteSize
            ? [0, 0, 0, 0]
            : [bytes[base], bytes[base + 1], bytes[base + 2], 255];
        const row = new Uint8ClampedArray(width * 4);
        for (let i = 0; i < row.length; i += 4) row.set(rgba, i);
        for (let columnY = y; columnY < y + height; columnY++) {
            pixels.data.set(row, (columnY * gif.width + x) * 4);
        }
    }
    clearArea(0, 0, gif.width, gif.height, gif.frameInfo(0).transparent_index !== null);
    const frames = [];
    let size = 0, lastYield = performance.now();
    for (let i = 0; i < gif.numFrames(); i++) {
        if (cancelled()) return;
        const info = gif.frameInfo(i);
        if (
            !info.width || !info.height || info.x + info.width > gif.width ||
            info.y + info.height > gif.height
        ) {
            throw new Error("This GIF has an invalid frame.");
        }
        const previous = info.disposal === 3 ? pixels.data.slice() : null;
        gif.decodeAndBlitFrameRGBA(i, pixels.data);
        ctx.putImageData(pixels, 0, 0);
        const image = cropBackground(canvas, source, gif.width, gif.height);
        const ms = info.delay ? info.delay * 10 : 100;
        if (frames.at(-1)?.image === image) frames.at(-1).ms += ms;
        else {
            frames.push({ image, ms });
            size += image.length;
            if (size > 4 * 1024 * 1024) {
                throw new Error("This animation is too large for the profile. Choose a shorter GIF.");
            }
        }
        if (previous) pixels.data.set(previous);
        else if (info.disposal === 2) {
            clearArea(info.x, info.y, info.width, info.height, info.transparent_index !== null);
        }
        if (performance.now() - lastYield >= 30) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
        }
    }
    const loops = gif.loopCount();
    return { frames, plays: loops === null ? 1 : loops === 0 ? 0 : loops + 1 };
}
