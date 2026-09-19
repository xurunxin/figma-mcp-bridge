type Message = { type: string; requestId?: string; [key: string]: unknown };

/** Owns one connection generation. Canvas requests are never queued or replayed. */
export function createBridgeClient(options: {
  url: string;
  onStatus: (connected: boolean) => void;
  onRequest: (message: Message) => void;
  socket?: (url: string) => WebSocket;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let socket: WebSocket | null = null;
  let disposed = false;
  let attempts = 0;
  let lastSeen = now();
  let heartbeat = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();

  function detach() {
    clearTimeout(deadline);
    deadline = undefined;
    pending.clear();
    heartbeat = false;
    const old = socket;
    socket = null;
    if (old) {
      old.onopen = old.onclose = old.onerror = old.onmessage = null;
      old.close();
    }
  }

  function disconnected() {
    if (disposed) return;
    detach();
    options.onStatus(false);
    if (retry !== undefined) return;
    const delay = Math.min(500 * 2 ** Math.min(attempts++, 4), 5000);
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, delay);
  }

  function connect() {
    if (disposed) return;
    detach();
    let ws: WebSocket;
    try {
      ws = (options.socket ?? ((url) => new WebSocket(url)))(options.url);
    } catch {
      disconnected();
      return;
    }
    socket = ws;
    lastSeen = now();
    const current = () => !disposed && socket === ws;
    deadline = setTimeout(() => {
      if (current()) disconnected();
    }, 8000);
    ws.onopen = () => {
      if (!current()) return;
      clearTimeout(deadline);
      lastSeen = now();
      attempts = 0;
      options.onStatus(true);
      // Older bridges ignore this frame. Enable heartbeats only after an ACK.
      try {
        ws.send(JSON.stringify({ type: "bridge-hello" }));
      } catch {
        disconnected();
      }
    };
    ws.onerror = ws.onclose = () => {
      if (current()) disconnected();
    };
    ws.onmessage = (event) => {
      if (!current()) return;
      let message: Message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      lastSeen = now();
      if (message.type === "bridge-ready") {
        heartbeat = true;
        return;
      }
      if (message.type === "bridge-pong") return;
      if (typeof message.requestId !== "string" || typeof message.type !== "string") return;
      if (pending.has(message.requestId)) return;
      pending.add(message.requestId);
      options.onRequest(message);
    };
  }

  const timer = setInterval(() => {
    if (!socket || socket.readyState !== 1 || !heartbeat) return;
    if (now() - lastSeen >= 60000) {
      disconnected();
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "bridge-ping" }));
    } catch {
      disconnected();
    }
  }, 20000);
  connect();
  return {
    respond(message: Message) {
      if (!message.requestId || !pending.delete(message.requestId) || socket?.readyState !== 1)
        return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        disconnected();
      }
    },
    wake() {
      if (disposed) return;
      if (!socket || now() - lastSeen >= 60000) {
        clearTimeout(retry);
        retry = undefined;
        options.onStatus(false);
        connect();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearInterval(timer);
      detach();
    },
  };
}
