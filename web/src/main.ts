import "./styles.css";
import { ToolApp } from "./ui/app.ts";

const mount = document.getElementById("tool-mount")!;
const app = new ToolApp();
app.mount(mount);
(window as unknown as { tool: ToolApp }).tool = app;

// ---- full-window tool view -------------------------------------------------
const appView = document.getElementById("app-view")!;

// Load the bundled demo (show + audio) lazily, the first time the tool opens —
// so the landing never pays for the ~1.6 MB demo track.
let demoLoaded = false;
function loadDemoOnce(): void {
  if (demoLoaded) return;
  demoLoaded = true;
  void app.loadDemo("./demo/demo_show.xml", 140).then(() => app.loadAudioUrl("./demo/demo_audio.mp3"));
}

function openTool(): void {
  loadDemoOnce();
  document.body.classList.add("tool-open");
  appView.setAttribute("aria-hidden", "false");
  void appView.offsetWidth; // force a synchronous reflow so fit() reads the real width
  app.fit();
  requestAnimationFrame(() => app.fit()); // backup once layout fully settles
}
function closeTool(): void {
  document.body.classList.remove("tool-open");
  appView.setAttribute("aria-hidden", "true");
}

document.querySelectorAll<HTMLElement>("[data-open-tool]").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    openTool();
  }),
);
document.querySelector(".app-close")?.addEventListener("click", () => closeTool());
window.addEventListener("keydown", (e) => {
  const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "Escape" && document.body.classList.contains("tool-open") && !typing) closeTool();
});
if (location.hash === "#tool") openTool();

// ---- smooth-scroll in-page anchors (e.g. about), skipping the tool opener ----
document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]:not([data-open-tool])').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href")!.slice(1);
    const target = document.getElementById(id);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});
