import React, { useEffect, useMemo, useRef, useState } from "react";
import { createBridgeClient } from "./bridge-client";
import hoppLogo from "./assets/hopp-logo.png";

type PluginStatus = {
  fileName: string;
  fileKey: string;
  selectionCount: number;
};

// `||` (not `??`) so an empty build-time value falls back to the default.
// A custom endpoint must also be listed in manifest.json's
// networkAccess.allowedDomains or Figma will block the connection.
const WS_BASE_URL = import.meta.env.VITE_FIGMA_BRIDGE_WS || "ws://localhost:1994/ws";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<PluginStatus>({
    fileName: "Unknown file",
    fileKey: "",
    selectionCount: 0,
  });
  const clientRef = useRef<ReturnType<typeof createBridgeClient> | null>(null);

  const statusLabel = useMemo(
    () => (connected ? "WebSocket Connected" : "Disconnected"),
    [connected]
  );

  // One definition, rendered either in the collapsed bar or in the footer --
  // never both at once, since .body is hidden while collapsed.
  const statusBadge = (
    <div className={`badge ${connected ? "connected" : "disconnected"}`}>
      <span className="dot" />
      <span className="badge-text">{statusLabel}</span>
    </div>
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;

      if (msg.type === "plugin-status") {
        setStatus(msg.payload);
        return;
      }

      if (msg.type === "ui-collapse-state") {
        setCollapsed(msg.payload?.collapsed === true);
        return;
      }

      if (!("requestId" in msg)) {
        return;
      }

      clientRef.current?.respond(msg);
    };

    window.addEventListener("message", handleMessage);
    // The main thread reads the persisted state asynchronously, so ask for it
    // on mount rather than relying on a broadcast we may have missed.
    parent.postMessage({ pluginMessage: { type: "request-ui-state" } }, "*");
    parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      parent.postMessage({ pluginMessage: { type: "set-ui-collapsed", collapsed: next } }, "*");
      return next;
    });
  };

  // Connect/reconnect WebSocket when fileKey changes
  useEffect(() => {
    if (!status.fileKey) return;

    const client = createBridgeClient({
      url: `${WS_BASE_URL}?fileKey=${encodeURIComponent(status.fileKey)}&fileName=${encodeURIComponent(status.fileName)}`,
      onStatus: setConnected,
      onRequest: (payload) =>
        parent.postMessage({ pluginMessage: { type: "server-request", payload } }, "*"),
    });
    clientRef.current = client;
    const wake = () => client.wake();
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
      client.dispose();
      clientRef.current = null;
    };
  }, [status.fileKey, status.fileName]);

  return (
    <div className={`container ${collapsed ? "collapsed" : ""}`}>
      {collapsed && <div className="titlebar">{statusBadge}</div>}

      <button
        type="button"
        className="collapse-toggle"
        onClick={toggleCollapsed}
        title={collapsed ? "Restore" : "Minimize"}
        aria-label={collapsed ? "Restore" : "Minimize"}
        aria-expanded={!collapsed}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1 3.5 L5 7 L9 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="body">
        <div className="info-section">
          <div className="info-row">
            <span className="info-label">File:</span>
            <span className="info-value">{status.fileName}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Selection:</span>
            <span className="info-value">{status.selectionCount} node(s)</span>
          </div>
        </div>

        <div className="footer">
          {statusBadge}
          <a
            href="https://www.gethopp.app/?ref=figma-mcp-bridge"
            target="_blank"
            rel="noopener noreferrer"
            className="branding"
          >
            <img src={hoppLogo} alt="Hopp" className="logo" />
            <span className="sponsored-text">
              Sponsored by Hopp
              <br />
              The best open-source
              <br />
              pair-programming app
            </span>
          </a>
        </div>
      </div>
    </div>
  );
}
