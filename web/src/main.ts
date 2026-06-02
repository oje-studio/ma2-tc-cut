import "./styles.css";
import { ToolApp } from "./ui/app.ts";

const mount = document.getElementById("tool-mount")!;
const app = new ToolApp();
app.mount(mount);
(window as unknown as { tool: ToolApp }).tool = app;

// Preload the bundled synthetic demo so the timeline isn't empty on first view.
void app.loadDemo("./demo/demo_show.xml").then(() => app.loadAudioUrl("./demo/demo_audio.mp3"));

// Smooth-scroll the in-page nav / CTA links.
document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href")!.slice(1);
    const target = document.getElementById(id);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});
