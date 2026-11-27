"use strict";

const picker = document.getElementById("color");
const hex = document.getElementById("color-value");
const saveColor = bindInspector([picker], (settings, action, device) => {
    picker.value = arrowColor(settings);
    hex.value = picker.value.toUpperCase();
    document.querySelector('label[for="color"]').textContent =
        isNeoTouchPoint(device, action.context, action.payload.coordinates)
            ? "Touch point color"
            : "Arrow color";
});
picker.oninput = () => {
    hex.value = picker.value.toUpperCase();
};
picker.onchange = () => saveColor({ color: picker.value });
