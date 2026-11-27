"use strict";

const selector = document.getElementById("face");
const quota = document.getElementById("quota");
const returnSeconds = document.getElementById("return-seconds");
const upload = document.getElementById("background");
const scope = document.getElementById("background-scope");
const restore = document.getElementById("restore-background");
const status = document.getElementById("background-status");
const tintControls = document.getElementById("wallpaper-tint");
const tintColor = document.getElementById("tint-color");
const tintStrength = document.getElementById("tint-strength");
const tintValue = document.getElementById("tint-value");
const pageList = document.getElementById("page-list");
const showNowPlaying = document.getElementById("show-now-playing");
const defaultPageSelect = document.getElementById("default-page");
let preferredPage = "";
let pageRows = pageLayout();

function showDefaultPage() {
    defaultPageSelect.replaceChildren(new Option("First enabled page", ""));
    for (const row of pageRows) {
        const option = new Option(pageNames[row.id] + (row.enabled ? "" : " (off)"), row.id);
        option.disabled = !row.enabled;
        defaultPageSelect.add(option);
    }
    defaultPageSelect.value = preferredPage;
    const enabled = pageRows.filter((row) => row.enabled).map((row) => row.id);
    showNowPlaying.disabled = !enabled.includes("media") || enabled.length < 2;
    const active = defaultPageFor(preferredPage, enabled);
    defaultPageSelect.disabled = !active;
    document.getElementById("return-controls").disabled = enabled.length < 2;
    const status = document.getElementById("page-status");
    if (!active) status.textContent = "All pages are off. The Infobar is blank.";
    else if (preferredPage && preferredPage !== active) {
        status.textContent = pageNames[active] + " is the default while " + pageNames[preferredPage] +
            " is off.";
    } else status.textContent = "Opens first and returns when the timer expires.";
}

function showPages() {
    const focused = document.activeElement;
    const restoreFocus = pageList.contains(focused) ? focused.getAttribute("aria-label") : null;
    pageList.replaceChildren();
    for (const [index, row] of pageRows.entries()) {
        const name = pageNames[row.id];
        const item = document.createElement("div");
        item.className = "page-row";
        const label = document.createElement("label");
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = row.enabled;
        toggle.setAttribute("aria-label", name);
        toggle.onchange = () => {
            row.enabled = toggle.checked;
            save({ pages: pageRows });
            showPages();
        };
        label.append(toggle, name);
        item.append(label);
        for (const step of [-1, 1]) {
            const target = index + step;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = step < 0 ? "↑" : "↓";
            button.title = "Move " + name + (step < 0 ? " up" : " down");
            button.setAttribute("aria-label", button.title);
            button.disabled = target < 0 || target >= pageRows.length;
            button.onclick = () => {
                [pageRows[target], pageRows[index]] = [pageRows[index], pageRows[target]];
                save({ pages: pageRows });
                showPages();
            };
            item.append(button);
        }
        pageList.append(item);
    }
    showDefaultPage();
    if (restoreFocus) {
        const same = Array.from(pageList.querySelectorAll("[aria-label]")).find(
            (control) => control.getAttribute("aria-label") === restoreFocus,
        );
        (same?.disabled ? same.closest(".page-row").querySelector("input") : same)?.focus();
    }
}
for (const [value, label] of Object.entries(faces)) selector.add(new Option(label, value));
let previewTimer, background = new ClockBackground(), backgrounds = {}, importVersion = 0;
let wallpaperTints = {};
function selectedTint() {
    return { color: tintColor.value, strength: tintStrength.valueAsNumber };
}
function preview() {
    clearTimeout(previewTimer);
    const { image, delay } = background.at();
    previewTimer = setTimeout(preview, Math.min(delay, 60000 - Date.now() % 60000));
    const svg = frame([{
        art: clockScreen(selector.value, new Date(), (name) => "assets/" + name + ".png", image, selectedTint()),
    }]);
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    document.getElementById("preview").replaceChildren(document.importNode(root, true));
}

function showBackground() {
    const shared = scope.value === "default";
    background = background.withSettings(
        shared ? backgrounds.default : backgroundForFace(backgrounds, selector.value),
    );
    restore.hidden = !backgrounds[shared ? "default" : selector.value];
    restore.textContent = shared ? "Remove shared background" : "Clear face background";
    tintControls.hidden = !background.frames.length;
    const tint = tintForFace(wallpaperTints, selector.value);
    tintColor.value = tint.color;
    tintStrength.value = tint.strength;
    tintValue.value = tint.strength + "%";
    document.getElementById("tint-title").textContent = faces[selector.value] + " wallpaper tint";
    preview();
}

const save = bindInspector([
    selector,
    quota,
    returnSeconds,
    scope,
    upload,
    restore,
    tintControls,
    document.getElementById("pages"),
], (settings) => {
    if (selector.value !== faceFor(settings)) {
        importVersion++;
        status.textContent = "";
    }
    selector.value = faceFor(settings);
    quota.value = quotaFor(settings);
    returnSeconds.value = returnSecondsFor(settings);
    backgrounds = settings?.backgrounds || {};
    wallpaperTints = settings?.wallpaperTints || {};
    pageRows = pageLayout(settings);
    showNowPlaying.checked = settings?.showNowPlaying === true;
    preferredPage = Object.hasOwn(pageNames, settings?.defaultPage) ? settings.defaultPage : "";
    showPages();
    showBackground();
});
showNowPlaying.onchange = () => save({ showNowPlaying: showNowPlaying.checked });
defaultPageSelect.onchange = () => {
    preferredPage = defaultPageSelect.value;
    save({ defaultPage: preferredPage });
    showDefaultPage();
};
selector.onchange = () => {
    importVersion++;
    status.textContent = "";
    upload.value = "";
    save({ face: selector.value });
    showBackground();
};
quota.onchange = () => save({ quota: quota.value });
scope.onchange = () => {
    importVersion++;
    status.textContent = "";
    upload.value = "";
    showBackground();
};
for (const input of [tintColor, tintStrength]) {
    input.oninput = () => {
        tintValue.value = tintStrength.value + "%";
        preview();
    };
    input.onchange = () => {
        wallpaperTints = { ...wallpaperTints, [selector.value]: selectedTint() };
        save({ wallpaperTints });
    };
}
returnSeconds.onchange = () => {
    if (returnSeconds.reportValidity()) save({ returnSeconds: returnSeconds.valueAsNumber });
};
upload.onchange = async () => {
    const file = upload.files[0];
    if (!file) return;
    const version = ++importVersion;
    const cancelled = () => version !== importVersion;
    status.textContent = "Preparing background…";
    try {
        const value = await importBackground(file, cancelled);
        if (cancelled()) return;
        backgrounds = { ...backgrounds, [scope.value === "default" ? "default" : selector.value]: value };
        save({ backgrounds });
        showBackground();
        status.textContent = "";
    } catch (error) {
        if (!cancelled()) {
            status.textContent = error instanceof Error && error.name === "Error"
                ? error.message
                : "Choose a readable PNG, JPEG, WebP, or GIF.";
        }
    } finally {
        if (!cancelled()) upload.value = "";
    }
};
restore.onclick = () => {
    importVersion++;
    const next = { ...backgrounds };
    delete next[scope.value === "default" ? "default" : selector.value];
    backgrounds = next;
    save({ backgrounds });
    status.textContent = "";
    showBackground();
};
showBackground();
showPages();
