const element = (id) => document.getElementById(id);
let evidence;
const tabs = await chrome.tabs.query({ url: ["https://www.figma.com/*", "https://figma.com/*"] });
for (const tab of tabs) {
  const option = document.createElement("option");
  option.value = String(tab.id);
  option.textContent = `${tab.id}: ${tab.title}`;
  element("tabs").append(option);
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  evidence = result;
  element("result").textContent = JSON.stringify(result, null, 2);
  return result;
}
element("connect").onclick = () =>
  send({
    type: "connect",
    config: {
      tabId: Number(element("tabs").value),
      wsUrl: element("endpoint").value,
      token: element("token").value,
    },
  });
for (const type of ["disconnect", "status", "cdp"]) element(type).onclick = () => send({ type });
for (const operation of ["inspect", "smoke", "verify"])
  element(operation).onclick = () => {
    if (operation === "smoke" && !element("allowSmoke").checked) {
      element("result").textContent = "请先明确允许在测试文件创建研究节点。";
      return;
    }
    return send({ type: "probe", operation });
  };
element("download").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(evidence ?? {}, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "figma-browser-evidence.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
await send({ type: "status" });
