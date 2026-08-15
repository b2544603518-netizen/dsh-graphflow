// src/client/index.ts
import React from "react";
var PANEL_STYLE = {
  position: "fixed",
  top: 56,
  right: 16,
  width: 340,
  maxHeight: "80vh",
  overflow: "auto",
  background: "var(--color-bg-elevated, #1e1f24)",
  border: "1px solid var(--color-border, #2a2b32)",
  borderRadius: 10,
  padding: 14,
  zIndex: 1e3,
  pointerEvents: "auto",
  boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 13,
  color: "var(--color-text, #e6e6ea)"
};
var STATUS_COLOR = {
  completed: "#2ea043",
  interrupted: "#d29922",
  rejected: "#f85149",
  failed: "#f85149",
  cancelled: "#8b949e"
};
function statusDot(status) {
  return React.createElement("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: STATUS_COLOR[status] ?? "#8b949e",
      marginRight: 6
    }
  });
}
function GraphFlowPanel() {
  const [snapshot, setSnapshot] = React.useState(null);
  const [open, setOpen] = React.useState(true);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/plugins/dsh-graphflow/state", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 1e3);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const runGraph = async (graphId) => {
    try {
      await fetch("/plugins/dsh-graphflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graphId })
      });
    } catch {
    }
  };
  if (!open) {
    return React.createElement("button", {
      style: {
        position: "fixed",
        top: 56,
        right: 16,
        zIndex: 1e3,
        pointerEvents: "auto",
        padding: "6px 10px",
        borderRadius: 8,
        background: "var(--color-bg-elevated, #1e1f24)",
        border: "1px solid var(--color-border, #2a2b32)",
        color: "var(--color-text, #e6e6ea)",
        cursor: "pointer"
      },
      onClick: () => setOpen(true)
    }, "GraphFlow");
  }
  const graphs = snapshot?.graphs ?? [];
  const runs = snapshot?.runs ?? [];
  return React.createElement(
    "div",
    { style: PANEL_STYLE },
    React.createElement(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
      React.createElement("strong", null, "GraphFlow"),
      React.createElement("button", {
        style: { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 16 },
        onClick: () => setOpen(false)
      }, "\xD7")
    ),
    error !== null && React.createElement("div", { style: { color: "#f85149", marginBottom: 8 } }, error),
    React.createElement(
      "div",
      { style: { marginBottom: 12 } },
      React.createElement("div", { style: { fontWeight: 600, marginBottom: 6 } }, `\u56FE (${graphs.length})`),
      graphs.length === 0 ? React.createElement("div", { style: { color: "#8b949e" } }, "\u65E0") : graphs.map((g) => React.createElement(
        "div",
        { key: g.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" } },
        React.createElement("span", null, g.id, " \xB7 ", String(g.nodeCount), " \u8282\u70B9"),
        React.createElement("button", {
          style: { padding: "2px 8px", borderRadius: 6, cursor: "pointer" },
          onClick: () => {
            void runGraph(g.id);
          }
        }, "\u8FD0\u884C")
      ))
    ),
    React.createElement(
      "div",
      null,
      React.createElement("div", { style: { fontWeight: 600, marginBottom: 6 } }, `\u8FD0\u884C\u5386\u53F2 (${runs.length})`),
      runs.length === 0 ? React.createElement("div", { style: { color: "#8b949e" } }, "\u65E0") : runs.map((r) => React.createElement(
        "div",
        { key: r.runId, style: { padding: "6px 0", borderTop: "1px solid var(--color-border, #2a2b32)" } },
        React.createElement(
          "div",
          null,
          statusDot(r.status),
          React.createElement("span", { style: { fontWeight: 500 } }, r.graphId),
          React.createElement("span", { style: { color: "#8b949e", marginLeft: 6 } }, r.status)
        ),
        r.error !== void 0 && React.createElement("div", { style: { color: "#f85149", fontSize: 12 } }, r.error),
        React.createElement(
          "div",
          { style: { color: "#8b949e", fontSize: 11, wordBreak: "break-all" } },
          JSON.stringify(r.finalState)
        )
      ))
    )
  );
}
var inject = [];
function apply(ctx) {
  ctx.effect(() => {
    const slots = ctx.get("slots");
    if (slots === void 0) return void 0;
    return slots.inject("shell.overlay", () => slots.register(
      { name: "shell.overlay", id: "dsh-graphflow-panel", order: 0 },
      () => React.createElement(GraphFlowPanel)
    )) ?? void 0;
  });
}
export {
  apply,
  inject
};
