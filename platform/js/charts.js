export function lineChart(points) {
  const width = 560;
  const height = 180;
  const max = Math.max(1, ...points.map((point) => point.mentions));
  const step = points.length > 1 ? (width - 24) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = 12 + index * step;
    const y = height - 20 - (point.mentions / max) * (height - 36);
    return [x, y];
  });
  const d = coords.map((pair, index) => `${index ? "L" : "M"}${pair[0]},${pair[1]}`).join(" ");
  const labels = points.map((point) => point.day.slice(5)).join(" · ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Mentions"><path d="${d}" fill="none" stroke="#2C9EFF" stroke-width="3"/>${coords.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#7dd3fc"/>`).join("")}</svg><p class="muted">${labels || "—"}</p>`;
}

export function bars(items, color = "#2C9EFF") {
  const max = Math.max(1, ...items.map((item) => item.value));
  return `<div>${items.map((item) => `<div style="display:grid;grid-template-columns:88px 1fr 36px;gap:8px;align-items:center;margin:6px 0"><span class="muted">${item.label}</span><span style="height:8px;background:${color};width:${Math.max(4, (item.value / max) * 100)}%;border-radius:99px"></span><strong>${item.value}</strong></div>`).join("") || '<p class="muted">—</p>'}</div>`;
}
