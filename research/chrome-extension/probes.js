// Functions are serialized into a page context by chrome.scripting. No closures or remote code.
export async function pageProbe(operation = "inspect", priorNodeId) {
  const api = globalThis.figma;
  const methods = ["getNodeByIdAsync", "createFrame", "createText", "loadFontAsync"];
  const available = Object.fromEntries(
    methods.map((name) => [name, typeof api?.[name] === "function"])
  );
  const surface = {
    url: location.origin + location.pathname,
    canvasCount: document.querySelectorAll("canvas").length,
    iframeCount: document.querySelectorAll("iframe").length,
    figmaObjectPresent: !!api,
    available,
    sceneReadable: !!api?.currentPage && Array.isArray(api.currentPage.children),
    note: "Presence of an object is not proof of a supported public browser API.",
  };
  if (operation === "inspect") return surface;
  if (!surface.sceneReadable || methods.some((name) => !available[name])) {
    return {
      ...surface,
      operation,
      status: "UNSUPPORTED",
      reason: "No equivalent Figma scene API exposed in this page context",
    };
  }
  if (operation === "verify") {
    const node = await api.getNodeByIdAsync(priorNodeId);
    return {
      ...surface,
      operation,
      status: node ? "OBSERVED" : "FAILED",
      persistedNodeId: node?.id ?? null,
    };
  }
  if (operation !== "smoke") throw new Error("Unsupported probe");
  // This isolated test creates only its own frame and text. It never edits/deletes existing nodes.
  let frame, label;
  try {
    await api.loadFontAsync({ family: "Inter", style: "Regular" });
    frame = api.createFrame();
    frame.name = `Chrome bridge research ${new Date().toISOString()}`;
    frame.resize(320, 180);
    label = api.createText();
    frame.appendChild(label);
    label.fontName = { family: "Inter", style: "Regular" };
    label.characters = "Extension capability test";
    label.x = 16;
    label.y = 16;
    frame.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.95, b: 1 } }];
    const bytes = await frame.exportAsync({ format: "PNG" });
    return {
      ...surface,
      operation,
      status: "OBSERVED",
      nodeId: frame.id,
      textId: label.id,
      exportBytes: bytes.length,
      readback: (await api.getNodeByIdAsync(label.id)).characters,
      persistence: "NOT_RUN: reload the page, then verify this node ID",
    };
  } catch (error) {
    return {
      ...surface,
      operation,
      status: frame ? "PARTIAL" : "FAILED",
      nodeId: frame?.id,
      textId: label?.id,
      error: String(error),
      retry: "Read back recorded IDs before retrying; created nodes may already exist.",
    };
  }
}
