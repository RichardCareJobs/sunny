const log = document.getElementById("log");
const demoButton = document.getElementById("btn-demo");

function appendLog(message) {
  if (!log) return;
  const timestamp = new Date().toLocaleString();
  log.textContent = `[${timestamp}] ${message}`;
}

if (demoButton) {
  demoButton.addEventListener("click", () => {
    appendLog("Demo action fired. Advertiser workflows coming soon.");
    if (window.dataLayer) {
      window.dataLayer.push({ event: "ads_demo_action", section: "ads_console" });
    }
  });
}
