import Logo from "./Logo.jsx";
function Icon({ kind, x, y, size = 18 }) {
  const paths = {
    search: (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <path d="m15 15 5 5" />
      </>
    ),
    bell: (
      <>
        <path d="M6 16h12l-2-3V8a4 4 0 0 0-8 0v5zM10 20h4" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
      </>
    ),
    arrow: <path d="M5 19 19 5M6 5h13v13" />,
    folder: <path d="M3 6h7l2 3h9v11H3z" />,
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M10 4v16" />
      </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />
  };
  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / 24})`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind]}
    </g>
  );
}
export default function HarnessCorner({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="Inter, sans-serif" filter="url(#window-shadow)">
      <rect x="0" y="0" width="820" height="590" rx="18" fill="#111216" stroke="#383b46" />
      <path d="M18 1H802Q819 1 819 18V48H1V18Q1 1 18 1" fill="#191a1e" />
      <path d="M1 48H819" stroke="#2c2e36" />
      {["#ff5f57", "#febc2e", "#28c840"].map((color, i) => (
        <circle key={color} cx={24 + i * 21} cy="25" r="6" fill={color} />
      ))}
      <g color="#8a8e9a">
        <Icon kind="panel" x={95} y={16} />
        <path d="m135 20-4 5 4 5m23-10 4 5-4 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </g>
      <g color="#9295a0">
        <Icon kind="folder" x={207} y={17} size={16} />
        <text x="231" y="29" fontSize="10.5" fill="#d3d6df">
          New task
        </text>
      </g>
      <path d="M198 49V590" stroke="#292c35" />
      <Logo x={15} y={72} width={29} height={27} id="app-logo" />
      <text x="52" y="92" fontSize="18" fontWeight="650" fill="#f1f2f6" letterSpacing="-.6">
        CoworkOS
      </text>
      <g color="#a3a6b2">
        <Icon kind="search" x={151} y={78} size={16} />
        <Icon kind="bell" x={175} y={78} size={16} />
      </g>
      <g color="#e4e6ed">
        <Icon kind="arrow" x={17} y={113} size={17} />
        <text x="45" y="127" fill="currentColor" fontSize="12.5">
          New conversation
        </text>
      </g>
      <rect x="10" y="145" width="178" height="36" rx="8" fill="#272a32" />
      <rect x="10" y="154" width="2" height="18" rx="1" fill="#8099ff" />
      {[
        ["grid", "Workspace", 168],
        ["grid", "Apps", 209],
        ["bell", "Long-term tasks", 250]
      ].map(([kind, label, baseline], i) => (
        <g key={label} color={i === 0 ? "#f0f1f6" : "#a4a7b3"}>
          <Icon kind={kind} x={18} y={baseline - 14} size={17} />
          <text x="45" y={baseline} fontSize="13" fill="currentColor">
            {label}
          </text>
        </g>
      ))}
      <text x="18" y="286" fill="#8b909d" fontSize="10.5" letterSpacing=".4">
        Projects
      </text>
      <path d="M178 278v10m-5-5h10" stroke="#8b909d" strokeWidth="1.2" />
      {[
        ["Courtyard House", 313],
        ["Orbital Observatory", 346],
        ["Multi-agent trial", 379]
      ].map(([label, baseline]) => (
        <g key={label} color="#858b9a">
          <Icon kind="chevron" x={17} y={baseline - 11} size={12} />
          <text x="36" y={baseline} fill="#a7abb7" fontSize="11">
            {label}
          </text>
        </g>
      ))}
      {/* A short illustrative conversation fitted to the visible window corner. */}
      <g fontSize="10.5">
        <rect x="212" y="84" width="77" height="51" rx="10" fill="#292c34" />
        <text x="222" y="105" fill="#e5e7ed">
          <tspan x="222">Review this</tspan>
          <tspan x="222" dy="16">
            project.
          </tspan>
        </text>
        <text x="214" y="170" fill="#c3c8d4">
          <tspan x="214">I'll check</tspan>
          <tspan x="214" dy="17">
            the project
          </tspan>
          <tspan x="214" dy="17">
            structure.
          </tspan>
        </text>
        <g color="#a7b1c7">
          <Icon kind="folder" x={213} y={228} size={13} />
          <text x="233" y="238" fill="currentColor" fontSize="10">
            Read files
          </text>
        </g>
        <path
          d="M214 261H284M214 273H271M214 285H279"
          stroke="#2d3340"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </g>
  );
}
