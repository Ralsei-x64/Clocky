"use strict";

// Each inspector edits only its own fields. OpenDeck saves the complete settings object.
function bindInspector(controls, show) {
    let settings = {};
    let send = () => {};
    function enable(enabled) {
        for (const control of controls) control.disabled = !enabled;
    }
    window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
        const action = JSON.parse(actionInfo);
        const device = JSON.parse(info).devices?.find((item) => item.id === action.device);
        function apply(value) {
            settings = value ?? {};
            show(settings, action, device);
        }
        apply(action.payload.settings);
        enable(false);
        const socket = new WebSocket("ws://127.0.0.1:" + port);
        socket.onopen = () => {
            socket.send(JSON.stringify({ event: registerEvent, uuid }));
            send = () =>
                socket.send(
                    JSON.stringify({ event: "setSettings", context: action.context, payload: settings }),
                );
            enable(true);
        };
        socket.onmessage = ({ data }) => {
            const message = JSON.parse(data);
            if (message.event === "didReceiveSettings" && message.context === action.context) {
                apply(message.payload.settings);
            }
        };
        socket.onclose = () => {
            enable(false);
            send = () => {};
        };
    };
    return (patch) => {
        settings = { ...settings, ...patch };
        send();
    };
}
