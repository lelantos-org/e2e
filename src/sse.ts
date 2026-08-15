// Minimal server-sent-events reader over streaming `fetch`.
//
// Node ships no `EventSource` (still absent in 24), and the SDK takes the
// transport as a parameter rather than importing a polyfill that would weigh
// down its browser bundle. This is that parameter for the test suite.
//
// Deliberately no reconnect. The browser's is what makes a dropped SSE
// connection invisible; here a dropped connection is a result worth
// surfacing, and a test run is short enough that one connection covers it.
//
// Pure transport: no config, no env. Keep it that way so it stays testable on
// its own.

import type { EventSourceLike } from "@lelantos-org/sdk/relayer";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

const FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

/// Extract a frame's payload. `:`-prefixed lines are comments — the relayer's
/// keepalive heartbeat is one, and carries no data.
function payloadOf(frame: string): string {
    return frame
        .split("\n")
        .filter((line) => line.startsWith(DATA_PREFIX))
        .map((line) => line.slice(DATA_PREFIX.length).trim())
        .join("\n");
}

type Listener = (ev: { data?: unknown }) => void;

export function nodeEventSource(url: string): EventSourceLike {
    const abort = new AbortController();
    // A set per type, not one listener per type: `addEventListener` adds, and
    // a Map would have each registration silently evict the last.
    const listeners = new Map<string, Set<Listener>>();
    let readyState: number = CONNECTING;

    const emit = (type: string, ev: { data?: unknown } = {}) => {
        for (const listener of [...(listeners.get(type) ?? [])]) listener(ev);
    };
    const die = () => {
        if (readyState === CLOSED) return;
        readyState = CLOSED;
        emit("error");
    };

    void (async () => {
        try {
            const res = await fetch(url, {
                headers: { accept: "text/event-stream" },
                signal: abort.signal,
            });
            if (!res.ok || !res.body) {
                die();
                return;
            }
            readyState = OPEN;

            // `getReader` rather than async iteration: the latter needs a cast,
            // since the DOM lib does not declare `ReadableStream` iterable even
            // where the runtime implements it.
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                // A frame can straddle chunk boundaries, so decode as a stream
                // and only cut at a separator that has actually arrived.
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                for (
                    let end = buffer.indexOf(FRAME_SEPARATOR);
                    end !== -1;
                    end = buffer.indexOf(FRAME_SEPARATOR)
                ) {
                    const payload = payloadOf(buffer.slice(0, end));
                    buffer = buffer.slice(end + FRAME_SEPARATOR.length);
                    if (payload) emit("message", { data: payload });
                }
            }
            die(); // the server ended the stream
        } catch {
            die(); // aborted by close(), or the connection failed
        }
    })();

    return {
        get readyState() {
            return readyState;
        },
        addEventListener(type, listener) {
            const forType = listeners.get(type) ?? new Set<Listener>();
            forType.add(listener);
            listeners.set(type, forType);
        },
        close() {
            readyState = CLOSED;
            abort.abort();
        },
    };
}
