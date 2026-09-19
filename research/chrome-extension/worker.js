import { pageProbe } from "./probes.js";

let socket;
let heartbeat;
let reconnect;
let paired = false;

function isFigma(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["www.figma.com", "figma.com"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
async function settings() {
  return (await chrome.storage.session.get("settings")).settings;
}
async function selectedTab(tabId) {
  const config = await settings();
  const id = tabId ?? config?.tabId;
  if (!config || id !== config.tabId)
    throw new Error("Only the explicitly selected tab can be probed");
  const tab = await chrome.tabs.get(id);
  if (!isFigma(tab.url) || tab.url !== config.url)
    throw new Error("Selected tab changed; select and connect again");
  return tab;
}
async function runProbe(operation, tabId) {
  const tab = await selectedTab(tabId);
  const previous = (await chrome.storage.session.get("evidence")).evidence;
  const currentUrl = new URL(tab.url);
  if (
    operation === "verify" &&
    (!previous?.nodeId ||
      previous.tabId !== tab.id ||
      previous.url !== currentUrl.origin + currentUrl.pathname)
  )
    throw new Error("No smoke-test node for this file and tab");
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: pageProbe,
    args: [operation, operation === "verify" ? previous.nodeId : null],
  });
  const evidence = {
    ...result[0].result,
    tabId: tab.id,
    browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
    observedAt: new Date().toISOString(),
  };
  if (operation === "smoke" || !previous?.nodeId) await chrome.storage.session.set({ evidence });
  socket?.readyState === WebSocket.OPEN &&
    socket.send(JSON.stringify({ type: "evidence", data: evidence }));
  return evidence;
}
async function disconnect(clear = true) {
  clearInterval(heartbeat);
  clearTimeout(reconnect);
  paired = false;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = undefined;
  }
  if (clear) await chrome.storage.session.remove("settings");
}
async function connect(config, explicitlySelected = false) {
  await disconnect(false);
  const endpoint = new URL(config.wsUrl);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/research/ws"
  )
    throw new Error("Expected local research WebSocket endpoint");
  if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid pairing token");
  const tab = await chrome.tabs.get(config.tabId);
  if (!isFigma(tab.url)) throw new Error("Choose a Figma tab");
  if (!explicitlySelected && config.url !== tab.url)
    throw new Error("Selected tab changed; select and connect again");
  config.url = tab.url;
  await chrome.storage.session.set({ settings: config });
  const ws = new WebSocket(endpoint.href);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: config.token }));
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "authenticated") {
      paired = true;
      ws.send(
        JSON.stringify({ type: "tabs", tabs: [{ id: tab.id, url: tab.url, title: tab.title }] })
      );
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "keepalive" }));
      }, 20_000);
    }
    if (message.type === "probe" && paired) {
      try {
        const data = await runProbe("inspect", message.tabId);
        ws.send(JSON.stringify({ type: "result", requestId: message.requestId, data }));
      } catch (error) {
        ws.send(
          JSON.stringify({ type: "result", requestId: message.requestId, error: error.message })
        );
      }
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    clearInterval(heartbeat);
    paired = false;
    reconnect = setTimeout(() => {
      void settings()
        .then((saved) => saved && connect(saved))
        .catch(() => {});
    }, 2000);
  };
  return { connecting: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our popup can request probes. No externally-connectable or content-script command bridge.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html"))
    return false;
  (async () => {
    if (message.type === "connect") return connect(message.config, true);
    if (message.type === "disconnect") {
      await disconnect();
      return { disconnected: true };
    }
    if (message.type === "status")
      return { paired, evidence: (await chrome.storage.session.get("evidence")).evidence };
    if (message.type === "probe") {
      if (!["inspect", "smoke", "verify"].includes(message.operation))
        throw new Error("Unknown operation");
      return runProbe(message.operation);
    }
    if (message.type === "cdp") {
      const tab = await selectedTab();
      const target = { tabId: tab.id };
      await chrome.debugger.attach(target, "1.3");
      try {
        const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression:
            "JSON.stringify({figmaObjectPresent:typeof globalThis.figma!=='undefined',createFrame:typeof globalThis.figma?.createFrame,currentPage:!!globalThis.figma?.currentPage})",
          returnByValue: true,
        });
        return {
          route: "CDP",
          tabId: tab.id,
          data: response.result?.value,
          exceptions: response.exceptionDetails,
          observedAt: new Date().toISOString(),
        };
      } finally {
        await chrome.debugger.detach(target);
      }
    }
    throw new Error("Unknown request");
  })().then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.message })
  );
  return true;
});
void settings()
  .then((saved) => saved && connect(saved))
  .catch(() => {});
