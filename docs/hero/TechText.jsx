// Original path lettering and deterministic SVG animation, inspired by the
// selection frame in React Bits Tech Text. No upstream source is copied.
// These glyphs are a purpose-drawn CoworkOS wordmark, not a general text font.
const glyphs = [
  {
    letter: "C",
    width: 100,
    d: "M32 0H90Q100 0 100 10V23L85 38H45Q38 38 38 46V94Q38 102 45 102H85L100 117V130Q100 140 90 140H32Q0 140 0 108V32Q0 0 32 0Z"
  },
  {
    letter: "o",
    width: 92,
    d: "M29 28H63Q92 28 92 57V111Q92 140 63 140H29Q0 140 0 111V57Q0 28 29 28Z M37 62Q33 62 33 67V101Q33 106 37 106H55Q59 106 59 101V67Q59 62 55 62Z"
  },
  {
    letter: "w",
    width: 126,
    d: "M7 28H26Q33 28 33 35V101Q33 107 39 107Q46 107 46 101V55Q46 48 53 48H73Q80 48 80 55V101Q80 107 87 107Q93 107 93 101V35Q93 28 100 28H119Q126 28 126 35V111Q126 140 98 140H80Q70 140 63 132Q56 140 46 140H28Q0 140 0 111V35Q0 28 7 28Z"
  },
  {
    letter: "o",
    width: 92,
    d: "M29 28H63Q92 28 92 57V111Q92 140 63 140H29Q0 140 0 111V57Q0 28 29 28Z M37 62Q33 62 33 67V101Q33 106 37 106H55Q59 106 59 101V67Q59 62 55 62Z"
  },
  {
    letter: "r",
    width: 72,
    d: "M7 28H26Q33 28 33 35V40Q43 28 58 28H65Q72 28 72 35V51L58 65H48Q36 65 36 77V133Q36 140 29 140H7Q0 140 0 133V35Q0 28 7 28Z"
  },
  {
    letter: "k",
    width: 96,
    d: "M7 0H29Q36 0 36 7V74L65 34Q69 28 76 28H92Q101 28 95 37L63 80L96 131Q102 140 92 140H68Q62 140 58 133L36 98V133Q36 140 29 140H7Q0 140 0 133V7Q0 0 7 0Z"
  },
  {
    letter: "O",
    width: 104,
    d: "M32 0H77Q82 0 86 4L100 18Q104 22 104 28V108Q104 140 72 140H27Q22 140 18 136L4 122Q0 118 0 112V32Q0 0 32 0Z M43 38Q37 38 37 44V96Q37 102 43 102H61Q67 102 67 96V44Q67 38 61 38Z"
  },
  {
    letter: "S",
    width: 100,
    d: "M30 0H90Q100 0 100 10V22L86 36H41Q35 36 35 42V46Q35 52 41 52H70Q100 52 100 82V110Q100 140 70 140H10Q0 140 0 130V117L14 103H58Q65 103 65 97V93Q65 87 58 87H30Q0 87 0 57V30Q0 0 30 0Z"
  }
];
const mixColor = (from, to, amount) =>
  `rgb(${from.map((value, i) => Math.round(value + (to[i] - value) * amount)).join(" ")})`;
export default function TechText({ text, x = 0, y = 0, time = 0, staticFrame = false, specks = 15 }) {
  if (text !== "CoworkOS") throw new Error("This custom wordmark supports CoworkOS only.");
  const phase = staticFrame ? 0 : ((time % 6) + 6) % 6;
  // Constant opacity and geometry: only OS smoothly changes its blue/lilac ink.
  const blend = (1 - Math.cos((phase / 6) * Math.PI * 2)) / 2;
  const blue = mixColor([114, 159, 255], [179, 143, 255], blend);
  const lilac = mixColor([186, 158, 255], [130, 183, 255], blend);
  let offset = 0;
  const letters = glyphs.map((glyph, index) => {
    const left = offset;
    offset += glyph.width + 8 + (index === 5 ? 16 : 0);
    return (
      <g key={index} transform={`translate(${left} 0)`}>
        <path d={glyph.d} fillRule="evenodd" fill={index >= 6 ? "url(#os-ink)" : "#f4f6ff"} />
      </g>
    );
  });
  return (
    <g transform={`translate(${x} ${y})`}>
      <defs>
        <linearGradient id="os-ink" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor={blue} />
          <stop offset="1" stopColor={lilac} />
        </linearGradient>
      </defs>
      {letters}
      <SelectionFrame time={phase} still={staticFrame} specks={specks} />
    </g>
  );
}

// A fixed rectangular track with two travelling packets and steady specks.
// No blinking, letter reveal, or particle respawning.
function SelectionFrame({ time, still, specks }) {
  const box = { left: 632, top: -17, width: 236, height: 174 };
  const perimeter = 2 * (box.width + box.height);
  const onEdge = (progress, outward = 0) => {
    const d = (((progress % 1) + 1) % 1) * perimeter;
    if (d < box.width) return [box.left + d, box.top - outward];
    if (d < box.width + box.height) return [box.left + box.width + outward, box.top + d - box.width];
    if (d < 2 * box.width + box.height)
      return [box.left + 2 * box.width + box.height - d, box.top + box.height + outward];
    return [box.left - outward, box.top + perimeter - d];
  };
  const random = (seed) => {
    const value = Math.sin(seed * 78.233 + 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };
  return (
    <g>
      <rect
        x={box.left}
        y={box.top}
        width={box.width}
        height={box.height}
        fill="none"
        stroke="#8fa6ff"
        strokeWidth="1"
        opacity=".5"
      />
      {[
        [632, -17],
        [868, -17],
        [632, 157],
        [868, 157]
      ].map(([cx, cy]) => (
        <rect key={`${cx}-${cy}`} x={cx - 2.5} y={cy - 2.5} width="5" height="5" fill="#bac8ff" />
      ))}
      <text
        x="632"
        y="-27"
        fontFamily="monospace"
        fontSize="9"
        letterSpacing=".5"
        fill="#94a9ef"
        opacity=".65"
      >
        OS 212 × 140
      </text>
      {!still &&
        [0, 0.5].map((head, track) => (
          <g key={track}>
            {[0, 1, 2, 3, 4].map((step) => {
              const [cx, cy] = onEdge(time / 3 + head - (step * 6) / perimeter);
              const size = step === 0 ? 4 : 2;
              return (
                <rect
                  key={step}
                  x={cx - size / 2}
                  y={cy - size / 2}
                  width={size}
                  height={size}
                  fill={step === 0 ? "#e5edff" : "#9bb7ff"}
                  opacity={Math.pow(0.55, step)}
                />
              );
            })}
          </g>
        ))}
      {Array.from({ length: specks }, (_, index) => {
        const seed = index * 47;
        const size = [2, 3, 3, 5, 8, 11][Math.floor(random(seed + 2) * 6)];
        const [rawX, rawY] = onEdge(random(seed), 8 + Math.floor(random(seed + 1) * 6) * 3);
        const cx = Math.round(rawX / 3) * 3,
          cy = Math.round(rawY / 3) * 3;
        const outlined = random(seed + 3) > 0.48;
        const opacity = 0.18 + random(seed + 4) * 0.16;
        return (
          <g key={index} opacity={opacity}>
            <rect
              x={cx - size / 2}
              y={cy - size / 2}
              width={size}
              height={size}
              stroke={outlined ? "#96afff" : "none"}
              strokeWidth="1"
              fill={outlined ? "none" : "#96afff"}
            />
            {outlined && size > 7 && <rect x={cx - 1} y={cy - 1} width="2" height="2" fill="#c3d1ff" />}
          </g>
        );
      })}
    </g>
  );
}
