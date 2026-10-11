import { Hono } from "hono";

const app = new Hono();

app.get("/healthz", (context) =>
  context.json({
    ok: true,
    service: "restic-monitor",
  }),
);

app.notFound((context) => context.json({ error: "not_found" }, 404));

export default app;
