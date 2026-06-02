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

// ---- per-tool detail overlays ----
function openDetail(slug: string): void {
  closeDetail();
  const d = document.getElementById("detail-" + slug);
  if (!d) return;
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  d.scrollTop = 0;
  document.body.classList.add("detail-open");
  history.replaceState(null, "", "#t/" + slug);
}
function closeDetail(): void {
  document.querySelectorAll(".tool-detail").forEach((d) => {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  });
  document.body.classList.remove("detail-open");
  if (location.hash.startsWith("#t/")) history.replaceState(null, "", location.pathname + location.search);
}
document.querySelectorAll<HTMLElement>(".tool-card[data-detail]").forEach((card) =>
  card.addEventListener("click", () => openDetail(card.dataset.detail!)),
);
document.querySelectorAll<HTMLElement>("[data-close-detail]").forEach((b) =>
  b.addEventListener("click", () => closeDetail()),
);

document.querySelectorAll<HTMLElement>("[data-open-tool]").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    openTool();
  }),
);
appView.querySelector(".app-close")?.addEventListener("click", () => closeTool());

// ---- fullscreen (true edge-to-edge; great on tablet / projector) ----
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen?.();
  } else {
    void appView.requestFullscreen?.().then(() => requestAnimationFrame(() => app.fit()));
  }
}
document.querySelector(".app-fs")?.addEventListener("click", () => toggleFullscreen());
document.addEventListener("fullscreenchange", () => requestAnimationFrame(() => app.fit()));

window.addEventListener("keydown", (e) => {
  const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  const appOpen = document.body.classList.contains("tool-open");
  if (e.key === "Escape" && !typing) {
    if (appOpen && !document.fullscreenElement) closeTool();
    else if (document.body.classList.contains("detail-open")) closeDetail();
  }
  if ((e.key === "f" || e.key === "F") && appOpen && !typing) toggleFullscreen();
});

// deep links
if (location.hash === "#tool") openTool();
else if (location.hash === "#t/ma2") openDetail("ma2");
else if (location.hash === "#t/cuemon") openDetail("cuemon");

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
