import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import TechText from "./TechText.jsx";
import HarnessCorner from "./HarnessCorner.jsx";
import Logo from "./Logo.jsx";
import "./scene.css";

const params = new URLSearchParams(location.search);
const recording = params.has("time") || params.has("capture");

function Hero() {
  const [time, setTime] = useState(Number(params.get("time")) || 0);
  const [still, setStill] = useState(
    params.has("static") || (!recording && matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
  useEffect(() => {
    window.renderHeroFrame = (value) => flushSync(() => setTime(value));
    document.documentElement.dataset.captureReady = "true";
    if (recording || still) return;
    let frame;
    const start = performance.now();
    const tick = (now) => {
      setTime(((now - start) / 1000) % 6);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return (
    <>
      <main className="hero" aria-label="CoworkOS">
        <svg viewBox="0 0 1440 480" role="img" aria-labelledby="hero-title">
          <title id="hero-title">CoworkOS — geometric wordmark and desktop workspace</title>
          <defs>
            <radialGradient id="ambient">
              <stop stopColor="#233d8a" stopOpacity=".22" />
              <stop offset="1" stopColor="#090c13" stopOpacity="0" />
            </radialGradient>
            <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="12" r=".75" fill="#a4b3d0" opacity=".12" />
            </pattern>
            <linearGradient id="bottom-fade" x2="0" y2="1">
              <stop offset="0" stopColor="#090c13" stopOpacity="0" />
              <stop offset="1" stopColor="#090c13" stopOpacity=".45" />
            </linearGradient>
            <filter id="window-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="16" stdDeviation="22" floodOpacity=".5" />
            </filter>
          </defs>
          <path fill="#090c13" d="M0 0H1440V480H0z" />
          <path fill="url(#dots)" d="M0 0H1440V480H0z" />
          <ellipse cx="350" cy="255" rx="560" ry="340" fill="url(#ambient)" />
          <HarnessCorner x={1140} y={150} />
          <Logo x={14} y={102} width={280} height={256} id="hero-logo" />
          <TechText text="CoworkOS" x={198} y={187} time={still ? 0 : time} staticFrame={still} specks={15} />
          <path d="M1140 430H1440V480H1140z" fill="url(#bottom-fade)" pointerEvents="none" />
        </svg>
      </main>
      {!recording && (
        <footer>
          <button onClick={() => setStill(!still)}>{still ? "Play animation" : "Static preview"}</button>
          <span>1440 × 480 · 6s loop</span>
        </footer>
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<Hero />);
